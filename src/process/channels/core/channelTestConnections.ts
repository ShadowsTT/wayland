/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in channel plugin connection tests.
 *
 * This module statically imports every plugin class (and therefore their heavy
 * messaging SDKs). It is loaded ONLY via a dynamic `import()` from
 * `ChannelManager.testPlugin`, so those SDKs evaluate solely when a user tests a
 * channel connection in Settings — never at app boot. The switch below is moved
 * verbatim from ChannelManager (behaviour unchanged); `pluginType` is now passed
 * in already resolved by the caller.
 */

import { getDatabase } from '@process/services/database';
import type { PluginType } from '../types';
import { TelegramPlugin } from '../plugins/telegram/TelegramPlugin';
import { LarkPlugin } from '../plugins/lark/LarkPlugin';
import { DingTalkPlugin } from '../plugins/dingtalk/DingTalkPlugin';
import { DiscordPlugin } from '../plugins/tier1/discord/DiscordPlugin';
import { SlackPlugin } from '../plugins/tier1/slack/SlackPlugin';
import { SmsTwilioPlugin } from '../plugins/tier1/sms/SmsTwilioPlugin';
import { WhatsAppPlugin } from '../plugins/tier1/whatsapp/WhatsAppPlugin';
import { EmailAgentMailPlugin } from '../plugins/tier1/email-agentmail/EmailAgentMailPlugin';
import { EmailImapPlugin } from '../plugins/tier1/email-imap/EmailImapPlugin';
import { MatrixPlugin } from '../plugins/tier2/matrix/MatrixPlugin';
import { LinePlugin } from '../plugins/tier2/line/LinePlugin';
import { WebhookPlugin } from '../plugins/tier1/webhook/WebhookPlugin';
import { IrcPlugin } from '../plugins/tier3/irc/IrcPlugin';
import { MattermostPlugin } from '../plugins/tier3/mattermost/MattermostPlugin';
import { GoogleChatPlugin } from '../plugins/tier3/google-chat/GoogleChatPlugin';
import { NextcloudTalkPlugin } from '../plugins/tier3/nextcloud-talk/NextcloudTalkPlugin';
import { SynologyChatPlugin } from '../plugins/tier3/synology-chat/SynologyChatPlugin';
import { NostrPlugin } from '../plugins/tier3/nostr/NostrPlugin';
import { TwitchPlugin } from '../plugins/tier3/twitch/TwitchPlugin';
import { BluebubblesPlugin } from '../plugins/tier3/bluebubbles/BluebubblesPlugin';
import { ImessagePlugin } from '../plugins/tier2/imessage/ImessagePlugin';
import { SignalPlugin } from '../plugins/tier1/signal/SignalPlugin';
import { MsTeamsPlugin } from '../plugins/tier2/ms-teams/MsTeamsPlugin';

/**
 * Test a built-in plugin's connection with the given credentials. `pluginType`
 * is resolved by the caller (ChannelManager.testPlugin). Extension plugins that
 * lack a static testConnection fall through to a generic success.
 */
export async function testChannelPluginConnection(
  pluginType: PluginType,
  token: string,
  extraConfig?: { appId?: string; appSecret?: string }
): Promise<{ success: boolean; botUsername?: string; error?: string }> {
  if (pluginType === 'telegram') {
    const result = await TelegramPlugin.testConnection(token);
    return {
      success: result.success,
      botUsername: result.botInfo?.username,
      error: result.error,
    };
  }

  if (pluginType === 'lark') {
    const appId = extraConfig?.appId;
    const appSecret = extraConfig?.appSecret;
    if (!appId || !appSecret) {
      return {
        success: false,
        error: 'App ID and App Secret are required for Lark',
      };
    }
    const result = await LarkPlugin.testConnection(appId, appSecret);
    return {
      success: result.success,
      botUsername: result.botInfo?.name,
      error: result.error,
    };
  }

  if (pluginType === 'dingtalk') {
    const clientId = extraConfig?.appId; // Reuse appId field for clientId
    const clientSecret = extraConfig?.appSecret; // Reuse appSecret field for clientSecret
    if (!clientId || !clientSecret) {
      return {
        success: false,
        error: 'Client ID and Client Secret are required for DingTalk',
      };
    }
    // R16 L5/L6: surface the caller-configured displayName so the returned
    // botUsername reflects what users see in DingTalk, not the hardcoded
    // "DingTalk Bot" string. `extraConfig` is typed narrowly upstream; the
    // dingtalk form passes displayName as a sibling field, so widen via
    // Record for the lookup.
    const cfg = extraConfig as Record<string, unknown> | undefined;
    const displayName = typeof cfg?.displayName === 'string' ? cfg.displayName : undefined;
    const result = await DingTalkPlugin.testConnection(clientId, clientSecret, displayName);
    return {
      success: result.success,
      botUsername: result.botInfo?.name,
      error: result.error,
    };
  }

  // Phase 1 (W1.1) - tier-1 plugins. Each static testConnection takes a
  // single string `token`; the renderer JSON-encodes structured credentials
  // (homeserverUrl/accessToken for Matrix, the {backend, accessToken,
  // phoneNumberId} blob for WhatsApp, etc.) per BasePlugin.testConnection
  // contract. See WhatsAppPlugin.ts line 505 for the pattern.

  if (pluginType === 'discord') {
    const result = await DiscordPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'slack') {
    const result = await SlackPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'sms-twilio') {
    const result = await SmsTwilioPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'whatsapp') {
    const result = await WhatsAppPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  // Phase 2 (W1.2) - tier-2 plugins.

  if (pluginType === 'email-agentmail') {
    const result = await EmailAgentMailPlugin.testConnection(token);
    return {
      success: result.success,
      // AgentMail returns inboxAddress on success - surface it as botUsername
      // so the renderer can both display "connected as <inbox>" AND auto-fill
      // the inboxAddress field if the user left it blank.
      botUsername: result.inboxAddress,
      error: result.error,
    };
  }

  if (pluginType === 'email-imap') {
    // Let the user re-test a saved connection without re-typing the app
    // password. The form rehydrates every field EXCEPT secrets (#548), so a
    // blank password on re-test means "keep the stored one" - fall back to it
    // here instead of testing with an empty string (which always fails).
    let effectiveToken = token;
    try {
      const parsed = JSON.parse(token) as Record<string, unknown>;
      const needsImapPw = !parsed.imapPassword;
      const needsSmtpPw = parsed.useSameAuth === false && !parsed.smtpPassword;
      if (needsImapPw || needsSmtpPw) {
        const db = await getDatabase();
        const stored = db.getChannelPlugin('email-imap').data?.credentials as Record<string, unknown> | undefined;
        if (stored) {
          if (needsImapPw && typeof stored.imapPassword === 'string') parsed.imapPassword = stored.imapPassword;
          if (needsSmtpPw && typeof stored.smtpPassword === 'string') parsed.smtpPassword = stored.smtpPassword;
          effectiveToken = JSON.stringify(parsed);
        }
      }
    } catch {
      // token was not JSON (shouldn't happen for email-imap) - test as-is.
    }
    const result = await EmailImapPlugin.testConnection(effectiveToken);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'matrix') {
    const result = await MatrixPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'line') {
    const result = await LinePlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  // OpenClaw fork wave 1 (W2.x) - 2026-05-18
  if (pluginType === 'webhook') {
    const result = await WebhookPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'irc') {
    const result = await IrcPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  // OpenClaw fork wave 2 (W2.y) - 2026-05-18
  if (pluginType === 'mattermost') {
    const result = await MattermostPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'google-chat') {
    const result = await GoogleChatPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'nextcloud-talk') {
    const result = await NextcloudTalkPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'synology-chat') {
    const result = await SynologyChatPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'nostr') {
    const result = await NostrPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  // OpenClaw fork wave 3 (W2.z) - 2026-05-18
  if (pluginType === 'twitch') {
    const result = await TwitchPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'bluebubbles') {
    const result = await BluebubblesPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'imessage') {
    const result = await ImessagePlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  // OpenClaw fork wave 4 (W2.w) - 2026-05-18
  if (pluginType === 'signal') {
    const result = await SignalPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  if (pluginType === 'ms-teams') {
    const result = await MsTeamsPlugin.testConnection(token);
    return { success: result.success, botUsername: result.botUsername, error: result.error };
  }

  // Extension plugins: test connection not supported yet (will be handled by the plugin itself on start)
  return { success: true, botUsername: undefined, error: undefined };
}
