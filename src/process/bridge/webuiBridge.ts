/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcMain } from 'electron';
import { webui } from '@/common/adapter/ipcBridge';
import { SERVER_CONFIG } from '@process/webserver/config/constants';
import { WebuiService } from './services/WebuiService';
import { generateQRLoginUrlDirect, verifyQRTokenDirect } from './webuiQR';
// Preload webserver module to avoid startup delay
import { startWebServerWithInstance } from '@process/webserver/index';
import { cleanupWebAdapter } from '@process/webserver/adapter';

export { generateQRLoginUrlDirect, verifyQRTokenDirect };

// WebUI server instance reference
let webServerInstance: {
  server: import('http').Server;
  wss: import('ws').WebSocketServer;
  port: number;
  allowRemote: boolean;
} | null = null;

/**
 * Set WebUI server instance (called from webserver/index.ts)
 */
export function setWebServerInstance(instance: typeof webServerInstance): void {
  webServerInstance = instance;
}

/**
 * Get WebUI server instance
 */
export function getWebServerInstance(): typeof webServerInstance {
  return webServerInstance;
}

/**
 * Initialize WebUI IPC bridge
 */
export function initWebuiBridge(): void {
  // Get WebUI status
  webui.getStatus.provider(async () => {
    return WebuiService.handleAsync(async () => {
      const status = await WebuiService.getStatus(webServerInstance);
      return { success: true, data: status };
    }, 'Get status');
  });

  // Start WebUI
  webui.start.provider(async ({ port: requestedPort, allowRemote }) => {
    try {
      // If server is already running, stop it first (supports restart for config changes)
      if (webServerInstance) {
        try {
          const { server: oldServer, wss: oldWss } = webServerInstance;
          oldWss.clients.forEach((client) => client.close(1000, 'Server restarting'));
          await new Promise<void>((resolve) => {
            oldServer.close(() => resolve());
            // Force resolve after 2s to avoid hanging
            setTimeout(resolve, 2000);
          });
          cleanupWebAdapter();
        } catch (err) {
          console.warn('[WebUI Bridge] Error stopping previous server:', err);
        }
        webServerInstance = null;
      }

      const preferredPort = requestedPort ?? SERVER_CONFIG.DEFAULT_PORT;
      const remote = allowRemote ?? false;

      // Use preloaded module
      const instance = await startWebServerWithInstance(preferredPort, remote);
      webServerInstance = instance;

      // Use actual port from instance (may differ from preferred if auto-incremented)
      const actualPort = instance.port;
      const status = await WebuiService.getStatus(webServerInstance);
      const localUrl = `http://localhost:${actualPort}`;
      const lanIP = WebuiService.getLanIP();
      const networkUrl = remote && lanIP ? `http://${lanIP}:${actualPort}` : undefined;
      const initialPassword = status.initialPassword;

      // Emit status changed event
      webui.statusChanged.emit({
        running: true,
        port: actualPort,
        localUrl,
        networkUrl,
      });

      return {
        success: true,
        data: {
          port: actualPort,
          localUrl,
          networkUrl,
          lanIP: lanIP ?? undefined,
          initialPassword,
        },
      };
    } catch (error) {
      console.error('[WebUI Bridge] Start error:', error);
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Failed to start WebUI',
      };
    }
  });

  // Stop WebUI
  webui.stop.provider(async () => {
    try {
      if (!webServerInstance) {
        return {
          success: false,
          msg: 'WebUI is not running',
        };
      }

      const { server, wss } = webServerInstance;

      // Close all WebSocket connections
      wss.clients.forEach((client) => {
        client.close(1000, 'Server shutting down');
      });

      // Close server
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Cleanup WebSocket broadcaster registration
      cleanupWebAdapter();

      webServerInstance = null;

      // Emit status changed event
      webui.statusChanged.emit({
        running: false,
      });

      return { success: true };
    } catch (error) {
      console.error('[WebUI Bridge] Stop error:', error);
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Failed to stop WebUI',
      };
    }
  });

  // Change password (no current password required)
  webui.changePassword.provider(async ({ newPassword }) => {
    return WebuiService.handleAsync(async () => {
      await WebuiService.changePassword(newPassword);
      return { success: true };
    }, 'Change password');
  });

  webui.changeUsername.provider(async ({ newUsername }) => {
    return WebuiService.handleAsync(async () => {
      const username = await WebuiService.changeUsername(newUsername);
      return { success: true, data: { username } };
    }, 'Change username');
  });

  // Reset password (generate new random password).
  // Note: Since @office-ai/platform bridge provider doesn't support return values,
  // we emit the result via emitter, frontend listens to resetPasswordResult event
  webui.resetPassword.provider(async () => {
    const result = await WebuiService.handleAsync(async () => {
      const newPassword = await WebuiService.resetPassword();
      return { success: true, data: { newPassword } };
    }, 'Reset password');

    // Emit result via emitter
    if (result.success && result.data) {
      webui.resetPasswordResult.emit({ success: true, newPassword: result.data.newPassword });
    } else {
      webui.resetPasswordResult.emit({ success: false, msg: result.msg });
    }

    return result;
  });

  // Generate QR login token
  webui.generateQRToken.provider(async () => {
    // Check webServerInstance status
    if (!webServerInstance) {
      return {
        success: false,
        msg: 'WebUI is not running. Please start WebUI first.',
      };
    }

    try {
      const { port, allowRemote } = webServerInstance;
      const { qrUrl, expiresAt } = generateQRLoginUrlDirect(port, allowRemote);
      // Extract token from QR URL
      const token = new URL(qrUrl).searchParams.get('token') ?? '';

      return {
        success: true,
        data: {
          token,
          expiresAt,
          qrUrl,
        },
      };
    } catch (error) {
      console.error('[WebUI Bridge] Generate QR token error:', error);
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Failed to generate QR token',
      };
    }
  });

  // Verify QR token
  webui.verifyQRToken.provider(async ({ qrToken }) => {
    return verifyQRTokenDirect(qrToken);
  });

  // ===== Direct IPC handlers (bypass bridge library) =====
  // These handlers return results directly, without relying on emitter pattern

  // Direct IPC: Reset password
  ipcMain.handle('webui-direct-reset-password', async () => {
    return WebuiService.handleAsync(async () => {
      const newPassword = await WebuiService.resetPassword();
      return { success: true, newPassword };
    }, 'Direct IPC: Reset password');
  });

  // Direct IPC: Get status
  ipcMain.handle('webui-direct-get-status', async () => {
    return WebuiService.handleAsync(async () => {
      const status = await WebuiService.getStatus(webServerInstance);
      return { success: true, data: status };
    }, 'Direct IPC: Get status');
  });

  // Direct IPC: Change password (no current password required)
  ipcMain.handle('webui-direct-change-password', async (_event, { newPassword }: { newPassword: string }) => {
    return WebuiService.handleAsync(async () => {
      await WebuiService.changePassword(newPassword);
      return { success: true };
    }, 'Direct IPC: Change password');
  });

  ipcMain.handle('webui-direct-change-username', async (_event, { newUsername }: { newUsername: string }) => {
    return WebuiService.handleAsync(async () => {
      const username = await WebuiService.changeUsername(newUsername);
      return { success: true, data: { username } };
    }, 'Direct IPC: Change username');
  });

  // Direct IPC: Generate QR token
  ipcMain.handle('webui-direct-generate-qr-token', async () => {
    // Check webServerInstance status
    if (!webServerInstance) {
      return {
        success: false,
        msg: 'WebUI is not running. Please start WebUI first.',
      };
    }

    try {
      const { port, allowRemote } = webServerInstance;
      const { qrUrl, expiresAt } = generateQRLoginUrlDirect(port, allowRemote);
      // Extract token from QR URL
      const token = new URL(qrUrl).searchParams.get('token') ?? '';

      return {
        success: true,
        data: {
          token,
          expiresAt,
          qrUrl,
        },
      };
    } catch (error) {
      console.error('[WebUI Bridge] Direct IPC: Generate QR token error:', error);
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Failed to generate QR token',
      };
    }
  });
}
