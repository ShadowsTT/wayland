/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lazy loaders for every built-in channel plugin.
 *
 * Each entry dynamically imports one plugin module, so its heavy messaging SDK
 * (discord.js, matrix-js-sdk ~16 MB, twilio ~20 MB, grammy, @slack/bolt,
 * imapflow + nodemailer, ...) is evaluated only when that plugin is actually
 * started — never at app boot. Previously ChannelManager statically imported all
 * 25 plugin classes, so every one of these SDKs was parsed on every launch even
 * for a user with no channels configured.
 *
 * `registerBuiltinChannelPlugins()` registers them all as lazy entries; the
 * registry key is created synchronously (so availability checks work at boot)
 * and the module is imported on first start. See PluginManager.registerPluginLazy.
 */

import type { BasePlugin } from '../plugins/BasePlugin';
import type { PluginType } from '../types';
import { registerPluginLazy } from '../gateway/PluginManager';

type PluginConstructor = new () => BasePlugin;
type PluginLoader = () => Promise<PluginConstructor>;

/**
 * type → dynamic import of its constructor. Keep in sync with the built-in
 * plugin set (the `builtinStartableTypes` allow-list in ChannelManager).
 */
export const CHANNEL_PLUGIN_LOADERS: Partial<Record<PluginType, PluginLoader>> = {
  telegram: () => import('../plugins/telegram/TelegramPlugin').then((m) => m.TelegramPlugin),
  lark: () => import('../plugins/lark/LarkPlugin').then((m) => m.LarkPlugin),
  dingtalk: () => import('../plugins/dingtalk/DingTalkPlugin').then((m) => m.DingTalkPlugin),
  weixin: () => import('../plugins/weixin/WeixinPlugin').then((m) => m.WeixinPlugin),
  wecom: () => import('../plugins/wecom/WecomPlugin').then((m) => m.WecomPlugin),
  discord: () => import('../plugins/tier1/discord/DiscordPlugin').then((m) => m.DiscordPlugin),
  slack: () => import('../plugins/tier1/slack/SlackPlugin').then((m) => m.SlackPlugin),
  'sms-twilio': () => import('../plugins/tier1/sms/SmsTwilioPlugin').then((m) => m.SmsTwilioPlugin),
  whatsapp: () => import('../plugins/tier1/whatsapp/WhatsAppPlugin').then((m) => m.WhatsAppPlugin),
  'email-agentmail': () =>
    import('../plugins/tier1/email-agentmail/EmailAgentMailPlugin').then((m) => m.EmailAgentMailPlugin),
  'email-imap': () => import('../plugins/tier1/email-imap/EmailImapPlugin').then((m) => m.EmailImapPlugin),
  matrix: () => import('../plugins/tier2/matrix/MatrixPlugin').then((m) => m.MatrixPlugin),
  line: () => import('../plugins/tier2/line/LinePlugin').then((m) => m.LinePlugin),
  webhook: () => import('../plugins/tier1/webhook/WebhookPlugin').then((m) => m.WebhookPlugin),
  irc: () => import('../plugins/tier3/irc/IrcPlugin').then((m) => m.IrcPlugin),
  mattermost: () => import('../plugins/tier3/mattermost/MattermostPlugin').then((m) => m.MattermostPlugin),
  'google-chat': () => import('../plugins/tier3/google-chat/GoogleChatPlugin').then((m) => m.GoogleChatPlugin),
  'nextcloud-talk': () =>
    import('../plugins/tier3/nextcloud-talk/NextcloudTalkPlugin').then((m) => m.NextcloudTalkPlugin),
  'synology-chat': () => import('../plugins/tier3/synology-chat/SynologyChatPlugin').then((m) => m.SynologyChatPlugin),
  nostr: () => import('../plugins/tier3/nostr/NostrPlugin').then((m) => m.NostrPlugin),
  twitch: () => import('../plugins/tier3/twitch/TwitchPlugin').then((m) => m.TwitchPlugin),
  bluebubbles: () => import('../plugins/tier3/bluebubbles/BluebubblesPlugin').then((m) => m.BluebubblesPlugin),
  imessage: () => import('../plugins/tier2/imessage/ImessagePlugin').then((m) => m.ImessagePlugin),
  signal: () => import('../plugins/tier1/signal/SignalPlugin').then((m) => m.SignalPlugin),
  'ms-teams': () => import('../plugins/tier2/ms-teams/MsTeamsPlugin').then((m) => m.MsTeamsPlugin),
};

/** Register every built-in plugin as a lazy entry. Called from ChannelManager. */
export function registerBuiltinChannelPlugins(): void {
  for (const [type, loader] of Object.entries(CHANNEL_PLUGIN_LOADERS)) {
    if (loader) registerPluginLazy(type as PluginType, loader);
  }
}
