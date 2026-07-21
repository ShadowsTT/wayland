/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { getDatabase } from '@process/services/database';
import { ExtensionRegistry } from '@process/extensions';
import { getChannelMessageService } from '../agent/ChannelMessageService';
import { getChannelDefaultModel } from '../actions/SystemActions';
import { ActionExecutor } from '../gateway/ActionExecutor';
import { PluginManager, registerPlugin } from '../gateway/PluginManager';
import { PairingService } from '../pairing/PairingService';
// Built-in plugins are registered lazily (channelPluginLoaders): their heavy
// SDKs load only when a plugin actually starts, not at boot. testPlugin's static
// imports live in channelTestConnections and are pulled in only on demand.
import { registerBuiltinChannelPlugins } from './channelPluginLoaders';
import { resolveChannelConvType } from '../types';
import type { ChannelPlatform, IChannelPluginConfig, PluginType } from '../types';
import { getTokenStore, registerWebhookDispatcher } from '../webhook';
import { ProcessConfig } from '@process/utils/initStorage';
import { SessionManager } from './SessionManager';

/**
 * ChannelManager - Main orchestrator for the Channel subsystem
 *
 * Singleton pattern - manages the lifecycle of all assistant components:
 * - PluginManager: Platform plugin lifecycle (Telegram, Slack, Discord)
 * - SessionManager: User session management
 * - PairingService: Secure pairing code generation and validation
 *
 * @example
 * ```typescript
 * // Initialize on app startup
 * await ChannelManager.getInstance().initialize();
 *
 * // Shutdown on app close
 * await ChannelManager.getInstance().shutdown();
 * ```
 */
export class ChannelManager {
  private static instance: ChannelManager | null = null;

  private initialized = false;
  private pluginManager: PluginManager | null = null;
  private sessionManager: SessionManager | null = null;
  private pairingService: PairingService | null = null;
  private actionExecutor: ActionExecutor | null = null;

  private constructor() {
    // Private constructor for singleton pattern.
    // Register built-in plugins as LAZY entries: each plugin module (and its
    // heavy messaging SDK) is imported only when that plugin first starts, not
    // here at boot. The registry keys are created synchronously so availability
    // checks still work. See channelPluginLoaders + PluginManager.registerPluginLazy.
    registerBuiltinChannelPlugins();
  }

  /**
   * Get the singleton instance of ChannelManager.
   *
   * Backed by globalThis, not just the module-static field: vite duplicates
   * this module across chunks (it is statically imported by channelBridge but
   * dynamically imported by conversationBridge), and a per-copy static would
   * yield TWO managers - one that boot-init starts plugins in, another that the
   * renderer's getPluginStatus IPC queries. That split made live plugin state
   * (connectionState, pairing QR) invisible to the UI. A global anchor makes
   * every copy resolve to the same instance.
   */
  static getInstance(): ChannelManager {
    const g = globalThis as typeof globalThis & { __waylandChannelManager?: ChannelManager };
    if (!g.__waylandChannelManager) {
      g.__waylandChannelManager = ChannelManager.instance ?? new ChannelManager();
    }
    ChannelManager.instance = g.__waylandChannelManager;
    return g.__waylandChannelManager;
  }

  /**
   * Initialize the assistant subsystem
   * Called during app startup
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log('[ChannelManager] Initializing...');

    try {
      // Register extension-contributed channel plugins (from ExtensionRegistry)
      this.registerExtensionChannelPlugins();

      // Initialize sub-components
      this.pairingService = new PairingService();
      this.sessionManager = new SessionManager();
      await this.sessionManager.ready;
      this.pluginManager = new PluginManager(this.sessionManager);

      // Create action executor and wire up message handling
      this.actionExecutor = new ActionExecutor(this.pluginManager, this.sessionManager, this.pairingService);
      this.pluginManager.setMessageHandler(this.actionExecutor.getMessageHandler());

      // Set confirm handler for tool confirmations
      this.pluginManager.setConfirmHandler(async (userId: string, platform: string, callId: string, value: string) => {
        // Find user
        const db = await getDatabase();
        const userResult = db.getChannelUserByPlatform(userId, platform as PluginType);
        if (!userResult.data) {
          console.error(`[ChannelManager] User not found: ${userId}@${platform}`);
          return;
        }

        // Find session to get conversationId
        const session = this.sessionManager?.getSession(userResult.data.id);
        if (!session?.conversationId) {
          console.error(`[ChannelManager] Session not found for user: ${userResult.data.id}`);
          return;
        }

        // Call confirm
        try {
          await getChannelMessageService().confirm(session.conversationId, callId, value);
        } catch (error) {
          console.error(`[ChannelManager] Tool confirmation failed:`, error);
        }
      });

      // Hydrate the webhook connection-token store from persisted state so
      // URLs minted in prior sessions still resolve after restart. Then wire
      // the inbound dispatcher: every signature-verified webhook lands here
      // and we look up the target plugin instance via PluginManager.
      await this.wireWebhookDispatcher();

      // Load and start enabled plugins from database
      await this.loadEnabledPlugins();

      this.initialized = true;
      console.log('[ChannelManager] Initialized successfully');
    } catch (error) {
      console.error('[ChannelManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Shutdown the assistant subsystem
   * Called during app close
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    console.log('[ChannelManager] Shutting down...');

    try {
      // Stop all plugins
      await this.pluginManager?.stopAll();

      // Stop pairing service cleanup interval
      this.pairingService?.stop();

      // Shutdown Gemini service
      await getChannelMessageService().shutdown();

      // Cleanup
      this.pluginManager = null;
      this.sessionManager = null;
      this.pairingService = null;
      this.actionExecutor = null;

      this.initialized = false;
      console.log('[ChannelManager] Shutdown complete');
    } catch (error) {
      console.error('[ChannelManager] Shutdown error:', error);
    }
  }

  /**
   * Check if the assistant subsystem is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Hydrate the singleton webhook token store from persisted state and
   * register the inbound dispatcher. Called once during initialize() AFTER
   * pluginManager exists.
   *
   * The dispatcher routes signature-verified payloads to the target plugin
   * by resolving pluginInstanceId → BasePlugin via PluginManager.getPlugin
   * and calling plugin.handleWebhookPayload(payload, headers, instanceId).
   *
   * If the plugin is missing (e.g. disabled), we log + drop; the receiver
   * still responds 202 so the platform doesn't retry forever.
   */
  private async wireWebhookDispatcher(): Promise<void> {
    try {
      const persisted = await ProcessConfig.get('webhook.connectionTokens');
      if (Array.isArray(persisted) && persisted.length > 0) {
        getTokenStore().hydrate(persisted);
        console.log(`[ChannelManager] Hydrated ${persisted.length} webhook connection token(s)`);
      }
    } catch (err) {
      console.error('[ChannelManager] Failed to hydrate webhook tokens:', err);
    }

    registerWebhookDispatcher(async (event) => {
      const plugin = this.pluginManager?.getPlugin(event.pluginInstanceId);
      if (!plugin) {
        console.warn(
          `[ChannelManager] Webhook arrived for unknown plugin instance: ${event.pluginInstanceId} (platform=${event.platform})`
        );
        return;
      }
      try {
        await plugin.handleWebhookPayload(event.payload, event.headers, event.pluginInstanceId);
      } catch (err) {
        console.error(`[ChannelManager] Plugin ${event.pluginInstanceId} threw on webhook delivery:`, err);
      }
    });
  }

  /**
   * Load and start enabled plugins from database
   */
  private async loadEnabledPlugins(): Promise<void> {
    const db = await getDatabase();
    const result = db.getChannelPlugins();

    if (!result.success || !result.data) {
      console.warn('[ChannelManager] Failed to load plugins:', result.error);
      return;
    }

    const enabledPlugins = result.data.filter((p) => p.enabled);
    // Must include EVERY built-in plugin registered in the constructor. Stale
    // lists here silently auto-disable user-configured plugins on restart.
    // Source of truth: registerPlugin() calls in the constructor (~lines 56-69).
    const builtinStartableTypes = new Set<PluginType>([
      'telegram',
      'lark',
      'dingtalk',
      'weixin',
      'wecom',
      // Phase 1 (W1.1) - tier-1 plugins
      'discord',
      'slack',
      'sms-twilio',
      'whatsapp',
      // Phase 2 (W1.2) - tier-2 plugins
      'email-agentmail',
      'email-imap',
      'matrix',
      // OpenClaw fork wave 1 (W2.x) - 2026-05-18
      'line',
      'webhook',
      'irc',
      // OpenClaw fork wave 2 (W2.y) - 2026-05-18
      'mattermost',
      'google-chat',
      'nextcloud-talk',
      'synology-chat',
      'nostr',
      // OpenClaw fork wave 3 (W2.z) - 2026-05-18
      'twitch',
      'bluebubbles',
      'imessage',
      // OpenClaw fork wave 4 (W2.w) - 2026-05-18
      'signal',
      'ms-teams',
    ]);
    const extensionRegistry = ExtensionRegistry.getInstance();

    for (const plugin of enabledPlugins) {
      const isBuiltinStartable = builtinStartableTypes.has(plugin.type);
      const hasExtensionPlugin = !!extensionRegistry.getChannelPluginMeta(plugin.type);
      const canStartInCurrentRuntime = isBuiltinStartable || hasExtensionPlugin;

      if (!canStartInCurrentRuntime) {
        console.warn(
          `[ChannelManager] Auto-disabling stale plugin ${plugin.id} (type=${plugin.type}) because it is not available in current runtime`
        );
        const nextConfig: IChannelPluginConfig = {
          ...plugin,
          enabled: false,
          status: 'stopped',
          updatedAt: Date.now(),
        };
        db.upsertChannelPlugin(nextConfig);
        continue;
      }

      try {
        await this.startPlugin(plugin);
      } catch (error) {
        console.error(`[ChannelManager] Failed to start plugin ${plugin.id}:`, error);
        // Update status to error
        db.updateChannelPluginStatus(plugin.id, 'error');
      }
    }
  }

  /**
   * Start a specific plugin
   */
  private async startPlugin(config: IChannelPluginConfig): Promise<void> {
    if (!this.pluginManager) {
      throw new Error('PluginManager not initialized');
    }
    await this.pluginManager.startPlugin(config);
  }

  /**
   * Enable and start a plugin.
   * Supports both built-in plugins and extension-contributed plugins.
   * For extension plugins, fields are extracted from manifest metadata.
   */
  async enablePlugin(pluginId: string, config: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
    // Ensure manager is initialized
    if (!this.initialized || !this.pluginManager) {
      console.error('[ChannelManager] Cannot enable plugin: manager not initialized');
      return { success: false, error: 'Assistant manager not initialized' };
    }

    const db = await getDatabase();

    // Get existing plugin or create new one
    const existingResult = db.getChannelPlugin(pluginId);
    const existing = existingResult.data;

    // Resolve plugin type - always derive from pluginId so stale DB records don't cause
    // "Unknown plugin type" errors after renaming or fixing the type mapping.
    const pluginType = this.getPluginTypeFromId(pluginId) as PluginType;
    let credentials = existing?.credentials;
    let pluginRuntimeConfig = existing?.config ? { ...existing.config } : {};

    // Extract credentials based on plugin type
    if (pluginType === 'telegram') {
      const token = config.token as string | undefined;
      if (token) {
        credentials = { token };
      }
    } else if (pluginType === 'lark') {
      const appId = config.appId as string | undefined;
      const appSecret = config.appSecret as string | undefined;
      const encryptKey = config.encryptKey as string | undefined;
      const verificationToken = config.verificationToken as string | undefined;
      if (appId && appSecret) {
        credentials = { appId, appSecret, encryptKey, verificationToken };
      }
    } else if (pluginType === 'dingtalk') {
      const clientId = config.clientId as string | undefined;
      const clientSecret = config.clientSecret as string | undefined;
      if (clientId && clientSecret) {
        credentials = { clientId, clientSecret };
      }
    } else if (pluginType === 'weixin') {
      const accountId = config.accountId as string | undefined;
      const botToken = config.botToken as string | undefined;
      if (accountId && botToken) {
        credentials = { accountId, botToken };
      }
    } else if (pluginType === 'wecom') {
      const botId = config.botId as string | undefined;
      const secret = config.secret as string | undefined;
      const token = config.token as string | undefined;
      const encodingAesKey = config.encodingAesKey as string | undefined;
      const corpId = config.corpId as string | undefined;

      if (botId && secret) {
        credentials = { botId: botId.trim(), secret: secret.trim() };
        pluginRuntimeConfig = { ...pluginRuntimeConfig, mode: 'websocket' };
      } else if (token && encodingAesKey && corpId) {
        // Webhook mode requires corpId so we can validate the trailing
        // receiveid bytes per WeCom spec (CRIT-2 audit fix 2026-05-18).
        credentials = {
          token: token.trim(),
          encodingAesKey: encodingAesKey.trim(),
          corpId: corpId.trim(),
        };
        pluginRuntimeConfig = { ...pluginRuntimeConfig, mode: 'webhook' };
      }
    } else if (pluginType === 'email-imap') {
      // EmailImapPlugin.resolveCredentials reads EVERY field (host, port, tls,
      // useSameAuth, smtp*) out of config.credentials. The generic extension
      // fallback below splits scalars (port/tls/useSameAuth) into runtimeConfig
      // and only keeps strings in credentials, so the plugin would never see
      // them and silently fall back to defaults. Keep the whole block together
      // in credentials. Passwords are whitespace-stripped to match the form +
      // resolveCredentials (Gmail/Outlook app passwords paste with spaces).
      const stripPw = (v: unknown): string | undefined => (typeof v === 'string' ? v.replace(/\s+/g, '') : undefined);
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);
      const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
      const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

      // Preserve the stored app password when the form re-saves with a blank
      // password field (#548: the form now rehydrates saved host/user/ports but
      // deliberately never receives the secret back, so an edit-and-save of any
      // OTHER field would otherwise wipe the password). A non-empty incoming
      // password always wins (a genuine rotation).
      const existingCreds = (existing?.credentials ?? {}) as Record<string, unknown>;
      const keepStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

      credentials = {
        imapHost: str(config.imapHost),
        imapPort: num(config.imapPort),
        imapUser: str(config.imapUser),
        imapPassword: stripPw(config.imapPassword) ?? keepStr(existingCreds.imapPassword),
        imapTls: bool(config.imapTls),
        useSameAuth: bool(config.useSameAuth),
        smtpHost: str(config.smtpHost),
        smtpPort: num(config.smtpPort),
        smtpTls: bool(config.smtpTls),
        smtpUser: str(config.smtpUser),
        smtpPassword: stripPw(config.smtpPassword) ?? keepStr(existingCreds.smtpPassword),
      };
    } else {
      // Extension or unknown plugin type:
      // - prefer manifest-declared credential/config fields
      // - preserve primitive types (string/number/boolean)
      const registry = ExtensionRegistry.getInstance();
      const meta = registry.getChannelPluginMeta(pluginType) as
        | {
            credentialFields?: Array<{ key: string }>;
            configFields?: Array<{ key: string }>;
          }
        | undefined;

      const nextCredentials: Record<
        string,
        string | number | boolean | readonly string[] | readonly number[] | undefined
      > = {
        ...credentials,
      };
      // pluginRuntimeConfig stays scalar-only - array-typed fields like IRC
      // channels[] or Nostr relays[] go to credentials (where they belong as
      // auth/scope material), not runtime config.
      const nextRuntimeConfig: Record<string, string | number | boolean | undefined> = {
        ...pluginRuntimeConfig,
      };

      // Accept arrays-of-primitives in addition to scalars so plugins that need
      // list-shaped credentials (IRC channels, Nostr relays, iMessage
      // allowedHandles) don't silently lose them on enable. Audit fix CRIT4
      // 2026-05-18: previously these were filtered out and dropped.
      const persistableEntries = Object.entries(config).filter(([, value]) => {
        const t = typeof value;
        if (t === 'string' || t === 'number' || t === 'boolean') return true;
        if (Array.isArray(value)) {
          return value.every((v) => typeof v === 'string' || typeof v === 'number');
        }
        return false;
      }) as Array<[string, string | number | boolean | readonly string[] | readonly number[]]>;

      const credentialKeys = new Set((meta?.credentialFields || []).map((f) => f.key));
      const configKeys = new Set((meta?.configFields || []).map((f) => f.key));

      // Type-narrow helpers - Array.isArray doesn't narrow a `readonly
      // string[] | readonly number[]` union back to a scalar in the
      // negative branch, so we use explicit type predicates.
      const isScalar = (v: unknown): v is string | number | boolean => {
        const t = typeof v;
        return t === 'string' || t === 'number' || t === 'boolean';
      };
      const isArrayValue = (v: unknown): v is readonly string[] | readonly number[] => Array.isArray(v);

      if (credentialKeys.size === 0 && configKeys.size === 0) {
        // Legacy fallback: strings + arrays are credentials (operator-typed
        // values plugins need to authenticate / connect); other primitives
        // go to runtime config.
        for (const [key, value] of persistableEntries) {
          if (typeof value === 'string' || isArrayValue(value)) {
            nextCredentials[key] = value;
          } else if (isScalar(value)) {
            nextRuntimeConfig[key] = value;
          }
        }
      } else {
        for (const [key, value] of persistableEntries) {
          if (credentialKeys.has(key)) {
            nextCredentials[key] = value;
            continue;
          }
          if (configKeys.has(key)) {
            // Arrays can't go into runtimeConfig (scalar-only); promote to
            // credentials instead.
            if (isArrayValue(value)) {
              nextCredentials[key] = value;
            } else if (isScalar(value)) {
              nextRuntimeConfig[key] = value;
            }
            continue;
          }
          // Unknown field fallback: arrays -> credentials; scalars -> runtime config.
          if (isArrayValue(value)) {
            nextCredentials[key] = value;
          } else if (isScalar(value)) {
            nextRuntimeConfig[key] = value;
          }
        }
      }

      credentials = nextCredentials;
      pluginRuntimeConfig = nextRuntimeConfig;
    }

    const pluginConfig: IChannelPluginConfig = {
      id: pluginId,
      type: pluginType,
      name: existing?.name || this.getPluginNameFromId(pluginId),
      enabled: true,
      credentials,
      config: pluginRuntimeConfig,
      status: 'created',
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };

    const saveResult = db.upsertChannelPlugin(pluginConfig);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    try {
      await this.startPlugin(pluginConfig);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Disable and stop a plugin
   */
  async disablePlugin(pluginId: string): Promise<{ success: boolean; error?: string }> {
    const db = await getDatabase();

    try {
      // Stop the plugin
      await this.pluginManager?.stopPlugin(pluginId);

      // Update database
      const existingResult = db.getChannelPlugin(pluginId);
      if (existingResult.data) {
        const updated: IChannelPluginConfig = {
          ...existingResult.data,
          enabled: false,
          status: 'stopped',
          updatedAt: Date.now(),
        };
        db.upsertChannelPlugin(updated);
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Test a plugin connection without enabling it.
   * For extension plugins that don't have a static testConnection method,
   * returns a generic "not supported" response.
   */
  async testPlugin(
    pluginId: string,
    token: string,
    extraConfig?: { appId?: string; appSecret?: string }
  ): Promise<{ success: boolean; botUsername?: string; error?: string }> {
    const pluginType = this.getPluginTypeFromId(pluginId);
    // Delegate to the connection tester. It statically imports every plugin
    // class (and their SDKs), so it is pulled in via a dynamic import here — the
    // SDKs load only when a user actually tests a connection, never at boot.
    const { testChannelPluginConnection } = await import('./channelTestConnections');
    return testChannelPluginConnection(pluginType, token, extraConfig);
  }

  /**
   * Get plugin type from plugin ID.
   * For built-in plugins, derives from ID prefix. For others, returns the ID as type.
   */
  private getPluginTypeFromId(pluginId: string): PluginType {
    // Order matters where prefixes overlap (e.g. 'email-imap' must be checked
    // before any 'email-' shorter prefix). Currently no overlaps, but kept
    // sorted longest-first to be safe.
    if (pluginId.startsWith('email-agentmail')) return 'email-agentmail';
    if (pluginId.startsWith('email-imap')) return 'email-imap';
    if (pluginId.startsWith('sms-twilio')) return 'sms-twilio';
    if (pluginId.startsWith('telegram')) return 'telegram';
    if (pluginId.startsWith('whatsapp')) return 'whatsapp';
    if (pluginId.startsWith('discord')) return 'discord';
    if (pluginId.startsWith('matrix')) return 'matrix';
    if (pluginId.startsWith('slack')) return 'slack';
    if (pluginId.startsWith('lark')) return 'lark';
    if (pluginId.startsWith('dingtalk')) return 'dingtalk';
    if (pluginId.startsWith('weixin')) return 'weixin';
    if (pluginId.startsWith('wecom')) return 'wecom';
    // OpenClaw fork wave 1 (W2.x) - 2026-05-18
    if (pluginId.startsWith('webhook')) return 'webhook';
    if (pluginId.startsWith('line')) return 'line';
    if (pluginId.startsWith('irc')) return 'irc';
    // OpenClaw fork wave 2 (W2.y) - 2026-05-18. Hyphenated types MUST be
    // checked before their bare-prefix counterparts (e.g. 'nextcloud-talk'
    // before any future 'nextcloud').
    if (pluginId.startsWith('nextcloud-talk')) return 'nextcloud-talk';
    if (pluginId.startsWith('synology-chat')) return 'synology-chat';
    if (pluginId.startsWith('google-chat')) return 'google-chat';
    if (pluginId.startsWith('mattermost')) return 'mattermost';
    if (pluginId.startsWith('nostr')) return 'nostr';
    // OpenClaw fork wave 3 (W2.z) - 2026-05-18
    if (pluginId.startsWith('bluebubbles')) return 'bluebubbles';
    if (pluginId.startsWith('imessage')) return 'imessage';
    if (pluginId.startsWith('twitch')) return 'twitch';
    // OpenClaw fork wave 4 (W2.w) - 2026-05-18. 'ms-teams' must be checked
    // before any future 'ms' prefix.
    if (pluginId.startsWith('ms-teams')) return 'ms-teams';
    if (pluginId.startsWith('signal')) return 'signal';
    // Extension plugins: use pluginId as type (e.g., 'ext-feishu')
    return pluginId;
  }

  /**
   * Get plugin name from plugin ID.
   * For extension plugins, tries to look up display name from registry.
   */
  private getPluginNameFromId(pluginId: string): string {
    // Check extension registry for display name
    try {
      const registry = ExtensionRegistry.getInstance();
      const meta = registry.getChannelPluginMeta(pluginId);
      if (meta && typeof meta === 'object' && 'name' in meta) {
        return (meta as { name: string }).name;
      }
    } catch {
      // Registry may not be initialized, fall through
    }
    const type = this.getPluginTypeFromId(pluginId);
    if (type === 'wecom') {
      return 'WeCom';
    }
    return type.charAt(0).toUpperCase() + type.slice(1) + ' Bot';
  }

  // ==================== Extension Channel Plugin Registration ====================

  /**
   * Register extension-contributed channel plugins into the plugin registry.
   * Called once during initialization after ExtensionRegistry is ready.
   * This is a synchronous, non-blocking operation (plugins are already loaded).
   */
  private registerExtensionChannelPlugins(): void {
    try {
      const registry = ExtensionRegistry.getInstance();
      const extPlugins = registry.getChannelPlugins();
      if (extPlugins.size === 0) return;

      for (const [type, entry] of extPlugins) {
        const Constructor = entry.constructor as new () => InstanceType<
          typeof import('../plugins/BasePlugin').BasePlugin
        >;
        registerPlugin(type as PluginType, Constructor as any);
        console.log(`[ChannelManager] Registered extension channel plugin: ${type}`);
      }
    } catch (error) {
      console.warn('[ChannelManager] Failed to register extension channel plugins:', error);
    }
  }

  // ==================== Settings Sync ====================

  /**
   * Sync channel settings after agent or model change in the Settings UI.
   * Clears all cached sessions so the next incoming message re-evaluates
   * which conversation to use. For gemini type changes, also updates the
   * model field on existing conversations.
   */
  async syncChannelSettings(
    platform: ChannelPlatform,
    agent: { backend: string; customAgentId?: string; name?: string },
    model?: { id: string; useModel: string }
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.initialized || !this.sessionManager) {
      return { success: false, error: 'Channel manager not initialized' };
    }

    try {
      const { convType: newType } = resolveChannelConvType(agent.backend);

      // For gemini + model info: update existing conversations' model field.
      // Existing channel conversations store `source = platform` for EVERY wired
      // channel (Slack/Discord/WhatsApp/Signal/Matrix/... as well as the five
      // built-ins), so a model change must propagate to all of them - not just
      // the built-in platforms. The DB column is a plain string; the narrow
      // typed signature is the only reason this was gated, so we widen it here.
      if (newType === 'gemini' && model?.id && model?.useModel) {
        const fullModel = await getChannelDefaultModel(platform);
        const db = await getDatabase();
        const result = db.updateChannelConversationModel(
          platform as 'telegram' | 'lark' | 'dingtalk' | 'weixin' | 'wecom',
          'gemini',
          fullModel
        );
        if (result.success) {
          console.log(`[ChannelManager] Updated ${result.data} gemini conversation(s) for ${platform}`);
        }
      }

      // Clear all sessions to force re-evaluation on next message
      const cleared = await this.sessionManager.clearAllSessions();
      console.log(`[ChannelManager] syncChannelSettings: platform=${platform}, type=${newType}, cleared=${cleared}`);

      return { success: true };
    } catch (error: any) {
      console.error(`[ChannelManager] syncChannelSettings failed:`, error);
      return { success: false, error: error.message };
    }
  }

  // ==================== Conversation Cleanup ====================

  /**
   * Cleanup resources when a conversation is deleted
   * Called when a non-Wayland conversation (e.g., telegram) is deleted
   *
   * @param conversationId - The ID of the conversation being deleted
   * @returns true if cleanup was performed, false if no resources to clean
   */
  async cleanupConversation(conversationId: string): Promise<boolean> {
    if (!this.initialized) {
      console.warn('[ChannelManager] Not initialized, skipping cleanup');
      return false;
    }

    let cleanedUp = false;

    // 1. Clear session associated with this conversation
    const clearedSession = await this.sessionManager?.clearSessionByConversationId(conversationId);
    if (clearedSession) {
      cleanedUp = true;

      // 2. Clear AssistantGeminiService agent cache for this session
      try {
        const geminiService = getChannelMessageService();
        await geminiService.clearContext(clearedSession.id);
      } catch (error) {
        console.warn(`[ChannelManager] Failed to clear Gemini context:`, error);
      }
    }

    return cleanedUp;
  }

  // ==================== Accessors ====================

  getPluginManager(): PluginManager | null {
    return this.pluginManager;
  }

  getSessionManager(): SessionManager | null {
    return this.sessionManager;
  }

  getPairingService(): PairingService | null {
    return this.pairingService;
  }

  getActionExecutor(): ActionExecutor | null {
    return this.actionExecutor;
  }
}

// Export singleton getter for convenience
export function getChannelManager(): ChannelManager {
  return ChannelManager.getInstance();
}
