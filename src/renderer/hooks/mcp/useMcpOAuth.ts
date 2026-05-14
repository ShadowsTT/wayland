import { useState, useCallback } from 'react';
import { mcpService } from '@/common/adapter/ipcBridge';
import type { IMcpServer } from '@/common/config/storage';

export interface McpOAuthStatus {
  isAuthenticated: boolean;
  needsLogin: boolean;
  isChecking: boolean;
  error?: string;
}

/**
 * MCP OAuth management hook.
 * Handles OAuth status checks and login flow for MCP servers.
 */
export const useMcpOAuth = () => {
  const [oauthStatus, setOAuthStatus] = useState<Record<string, McpOAuthStatus>>({});
  const [loggingIn, setLoggingIn] = useState<Record<string, boolean>>({});

  // Check OAuth status
  const checkOAuthStatus = useCallback(async (server: IMcpServer) => {
    // Only check HTTP/SSE servers
    if (server.transport.type !== 'http' && server.transport.type !== 'sse') {
      return;
    }

    setOAuthStatus((prev) => ({
      ...prev,
      [server.id]: {
        isAuthenticated: false,
        needsLogin: false,
        isChecking: true,
      },
    }));

    try {
      const response = await mcpService.checkOAuthStatus.invoke(server);

      if (response.success && response.data) {
        setOAuthStatus((prev) => ({
          ...prev,
          [server.id]: {
            isAuthenticated: response.data.isAuthenticated,
            needsLogin: response.data.needsLogin,
            isChecking: false,
            error: response.data.error,
          },
        }));
      } else {
        setOAuthStatus((prev) => ({
          ...prev,
          [server.id]: {
            isAuthenticated: false,
            needsLogin: false,
            isChecking: false,
            error: response.msg,
          },
        }));
      }
    } catch (error) {
      console.error('Failed to check OAuth status:', error);
      setOAuthStatus((prev) => ({
        ...prev,
        [server.id]: {
          isAuthenticated: false,
          needsLogin: false,
          isChecking: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      }));
    }
  }, []);

  // Perform OAuth login
  const login = useCallback(async (server: IMcpServer): Promise<{ success: boolean; error?: string }> => {
    setLoggingIn((prev) => ({ ...prev, [server.id]: true }));

    try {
      const response = await mcpService.loginMcpOAuth.invoke({
        server,
        config: undefined, // Use auto discovery
      });

      if (response.success && response.data?.success) {
        // Login succeeded; update status
        setOAuthStatus((prev) => ({
          ...prev,
          [server.id]: {
            isAuthenticated: true,
            needsLogin: false,
            isChecking: false,
          },
        }));
        return { success: true };
      } else {
        return {
          success: false,
          error: response.data?.error || response.msg || 'Login failed',
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      setLoggingIn((prev) => ({ ...prev, [server.id]: false }));
    }
  }, []);

  // Logout
  const logout = useCallback(
    async (serverName: string, serverId: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const response = await mcpService.logoutMcpOAuth.invoke(serverName);

        if (response.success) {
          // Logout succeeded; update status
          setOAuthStatus((prev) => ({
            ...prev,
            [serverId]: {
              isAuthenticated: false,
              needsLogin: true,
              isChecking: false,
            },
          }));
          return { success: true };
        } else {
          return {
            success: false,
            error: response.msg || 'Logout failed',
          };
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
    []
  );

  // Batch-check OAuth status for multiple servers
  const checkMultipleServers = useCallback(
    async (servers: IMcpServer[]) => {
      const httpServers = servers.filter((s) => s.transport.type === 'http' || s.transport.type === 'sse');

      await Promise.all(httpServers.map((server) => checkOAuthStatus(server)));
    },
    [checkOAuthStatus]
  );

  return {
    oauthStatus,
    loggingIn,
    checkOAuthStatus,
    checkMultipleServers,
    login,
    logout,
  };
};
