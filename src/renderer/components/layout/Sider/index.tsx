import classNames from 'classnames';
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePreviewContext } from '@renderer/pages/conversation/Preview/context/PreviewContext';
import { cleanupSiderTooltips, getSiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import { blurActiveElement } from '@renderer/utils/ui/focus';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';
import { useAllCronJobs } from '@renderer/pages/cron/useCronJobs';
import { SiderToolbar, SiderSearchEntry, SiderScheduledEntry } from './SiderNav';
import SiderFooter from './SiderFooter';
import CronJobSiderSection from './CronJobSiderSection';
import TeamSiderSection from './TeamSiderSection';
import siderStyles from './Sider.module.css';

const WorkspaceGroupedHistory = React.lazy(() => import('@renderer/pages/conversation/GroupedHistory'));
const SettingsSider = React.lazy(() => import('@renderer/pages/settings/components/SettingsSider'));

/**
 * Forge-suite branded sidebar header. Compact horizontal layout
 * (matches Direction B's logo treatment + Direction C's atmospheric
 * radial-gradient inside the mark container). Collapses to just the
 * mark centered when the sidebar is collapsed.
 */
const OrbitMark: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <svg
    viewBox='0 0 24 24'
    width={size}
    height={size}
    fill='none'
    stroke='#ff6b35'
    strokeWidth='2'
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
    focusable='false'
  >
    <path d='M20.341 6.484A10 10 0 0 1 10.266 21.85' />
    <path d='M3.659 17.516A10 10 0 0 1 13.74 2.152' />
    <circle cx='12' cy='12' r='3' />
    <circle cx='19' cy='5' r='2' />
    <circle cx='5' cy='19' r='2' />
  </svg>
);

const SiderBrand: React.FC<{ collapsed: boolean }> = ({ collapsed }) => {
  const markContainerStyle: React.CSSProperties = {
    width: 32,
    height: 32,
    flex: '0 0 32px',
    background:
      'radial-gradient(circle at 30% 30%, rgba(255, 107, 53, 0.15), transparent 70%), var(--bg-2)',
    border: '1px solid var(--border-mid, #353535)',
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
  };

  if (collapsed) {
    return (
      <div className='flex items-center justify-center pt-12px pb-14px shrink-0'>
        <div style={markContainerStyle}>
          <OrbitMark />
        </div>
      </div>
    );
  }

  return (
    <div className='flex items-center gap-12px px-16px pt-12px pb-14px shrink-0'>
      <div style={markContainerStyle}>
        <OrbitMark />
      </div>
      <div className='flex flex-col gap-2px min-w-0'>
        <span className='text-14px font-700 text-t-primary leading-none tracking-[0.01em]'>Wayland</span>
        <span className='text-10px font-500 uppercase tracking-[0.16em] text-[var(--text-dim,#555)] leading-none'>
          AI Agent
        </span>
      </div>
    </div>
  );
};

interface SiderProps {
  onSessionClick?: () => void;
  collapsed?: boolean;
}

const Sider: React.FC<SiderProps> = ({ onSessionClick, collapsed = false }) => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const location = useLocation();
  const { pathname, search, hash } = location;

  const navigate = useNavigate();
  const { closePreview } = usePreviewContext();
  const { logout, status } = useAuth();
  const { theme, setTheme } = useThemeContext();
  const [isBatchMode, setIsBatchMode] = useState(false);
  const { jobs: cronJobs } = useAllCronJobs();
  const isSettings = pathname.startsWith('/settings');
  const lastNonSettingsPathRef = useRef('/guid');
  const showLogout =
    typeof window !== 'undefined' && !(window as { electronAPI?: unknown }).electronAPI && status === 'authenticated';

  useEffect(() => {
    if (!pathname.startsWith('/settings')) {
      lastNonSettingsPathRef.current = `${pathname}${search}${hash}`;
    }
  }, [pathname, search, hash]);

  const handleNewChat = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    setIsBatchMode(false);
    Promise.resolve(navigate('/guid', { state: { resetAssistant: true } })).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleSettingsClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    if (isSettings) {
      const target = lastNonSettingsPathRef.current || '/guid';
      Promise.resolve(navigate(target)).catch((error) => {
        console.error('Navigation failed:', error);
      });
    } else {
      Promise.resolve(navigate('/settings/gemini')).catch((error) => {
        console.error('Navigation failed:', error);
      });
    }
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleConversationSelect = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    setIsBatchMode(false);
  };

  const handleScheduledClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    setIsBatchMode(false);
    Promise.resolve(navigate('/scheduled')).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleQuickThemeToggle = () => {
    void setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  const handleLogout = useCallback(async () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    try {
      await logout();
    } catch (error) {
      console.error('Logout failed:', error);
      return; // skip subsequent steps when logout fails
    }
    if (onSessionClick) {
      onSessionClick();
    }
  }, [closePreview, logout, onSessionClick]);

  useEffect(() => {
    if (!showLogout) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        handleLogout();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleLogout, showLogout]);

  const handleCronNavigate = (path: string) => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    Promise.resolve(navigate(path)).catch(console.error);
    if (onSessionClick) onSessionClick();
  };

  const tooltipEnabled = collapsed && !isMobile;
  const siderTooltipProps = getSiderTooltipProps(tooltipEnabled);

  const workspaceHistoryProps = {
    collapsed,
    tooltipEnabled,
    onSessionClick,
    batchMode: isBatchMode,
    onBatchModeChange: setIsBatchMode,
  };

  return (
    <div className='size-full flex flex-col'>
      {/* Main content area */}
      <div className='flex-1 min-h-0 overflow-hidden'>
        {isSettings ? (
          <Suspense fallback={<div className='size-full' />}>
            <SettingsSider collapsed={collapsed} tooltipEnabled={tooltipEnabled} />
          </Suspense>
        ) : (
          <div className='size-full flex flex-col gap-2px'>
            <SiderBrand collapsed={collapsed} />
            <SiderToolbar
              isMobile={isMobile}
              isBatchMode={isBatchMode}
              collapsed={collapsed}
              siderTooltipProps={siderTooltipProps}
              onNewChat={handleNewChat}
              onToggleBatchMode={() => setIsBatchMode((prev) => !prev)}
            />
            {/* Search entry */}
            <SiderSearchEntry
              isMobile={isMobile}
              collapsed={collapsed}
              siderTooltipProps={siderTooltipProps}
              onConversationSelect={handleConversationSelect}
              onSessionClick={onSessionClick}
            />
            {/* Scheduled tasks nav entry - fixed above scroll */}
            <SiderScheduledEntry
              isMobile={isMobile}
              isActive={pathname === '/scheduled'}
              collapsed={collapsed}
              siderTooltipProps={siderTooltipProps}
              onClick={handleScheduledClick}
            />
            {/* Divider between fixed top nav and scrollable content area */}
            <div
              className={classNames(
                'shrink-0 mt-4px mb-4px h-1px bg-[var(--color-border-2)]',
                collapsed ? 'mx-6px' : 'mx-10px'
              )}
            />
            {/* Scrollable content: team + scheduled tasks + conversation history */}
            <div className={classNames('flex-1 min-h-0 overflow-y-auto', siderStyles.scrollArea)}>
              {/* Team section */}
              <TeamSiderSection
                collapsed={collapsed}
                pathname={pathname}
                siderTooltipProps={siderTooltipProps}
                onSessionClick={onSessionClick}
              />
              {/* Scheduled section */}
              {!collapsed && (
                <CronJobSiderSection jobs={cronJobs} pathname={pathname} onNavigate={handleCronNavigate} />
              )}
              <Suspense fallback={<div className='min-h-200px' />}>
                <WorkspaceGroupedHistory {...workspaceHistoryProps} />
              </Suspense>
            </div>
          </div>
        )}
      </div>
      {/* Footer */}
      <SiderFooter
        isMobile={isMobile}
        isSettings={isSettings}
        collapsed={collapsed}
        theme={theme}
        siderTooltipProps={siderTooltipProps}
        onSettingsClick={handleSettingsClick}
        onThemeToggle={handleQuickThemeToggle}
        showLogout={showLogout}
        onLogoutClick={handleLogout}
      />
    </div>
  );
};

export default Sider;
