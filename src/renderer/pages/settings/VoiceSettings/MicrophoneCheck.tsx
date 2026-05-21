/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@arco-design/web-react';
import { Mic } from 'lucide-react';
import WaylandSelect from '@/renderer/components/base/WaylandSelect';

type CheckState = 'idle' | 'requesting' | 'live' | 'done' | 'error';

const TEST_DURATION_MS = 5000;
// Silence threshold: peak amplitude % under this for the full window = "muted".
const SILENCE_PEAK_PCT = 2;

const DEFAULT_DEVICE_ID = '';

const MicrophoneCheck: React.FC = () => {
  const { t } = useTranslation();
  const [state, setState] = useState<CheckState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(DEFAULT_DEVICE_ID);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const peakRef = useRef(0);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === 'audioinput'));
    } catch {
      // best-effort — leave list empty
    }
  }, []);

  // Enumerate once on mount. Labels stay empty until the user grants permission
  // at least once; we re-enumerate after the first successful Test below.
  useEffect(() => {
    void refreshDevices();
    if (!navigator.mediaDevices?.addEventListener) return;
    const handler = (): void => {
      void refreshDevices();
    };
    navigator.mediaDevices.addEventListener('devicechange', handler);
    return (): void => {
      navigator.mediaDevices.removeEventListener('devicechange', handler);
    };
  }, [refreshDevices]);

  const cleanup = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (stopTimerRef.current != null) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const handleStart = useCallback(async () => {
    setState('requesting');
    setErrorMsg('');
    setLevel(0);
    peakRef.current = 0;

    const constraints: MediaStreamConstraints = {
      audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      cleanup();
      setState('error');
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setErrorMsg(
          t(
            'settings.voiceMicPermissionBlocked',
            'Microphone access blocked. Open System Settings → Privacy → Microphone and enable Wayland.'
          )
        );
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setErrorMsg(
          t('settings.voiceMicNotFound', 'Selected microphone is not available. Pick another input device.')
        );
      } else {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    streamRef.current = stream;
    const ContextClass: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new ContextClass();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    source.connect(analyser);
    analyserRef.current = analyser;

    // First permission grant unlocks device labels — re-enumerate now.
    void refreshDevices();

    setState('live');
    const buffer = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(buffer);
      let peak = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] > peak) peak = buffer[i];
      }
      const pct = Math.round((peak / 255) * 100);
      setLevel(pct);
      if (pct > peakRef.current) peakRef.current = pct;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    stopTimerRef.current = setTimeout(() => {
      const silent = peakRef.current < SILENCE_PEAK_PCT;
      cleanup();
      if (silent) {
        setState('error');
        setErrorMsg(t('settings.voiceMicSilent', 'Mic appears muted. Check your input device.'));
      } else {
        setState('done');
      }
    }, TEST_DURATION_MS);
  }, [cleanup, refreshDevices, selectedDeviceId, t]);

  const buttonLabel =
    state === 'requesting'
      ? t('settings.voiceMicRequesting', 'Requesting access…')
      : state === 'live'
        ? t('settings.voiceMicListening', 'Listening…')
        : t('settings.voiceMicTest', 'Test microphone');

  const deviceOptionLabel = (d: MediaDeviceInfo, index: number): string => {
    if (d.label) return d.label;
    // No permission yet → device.label is empty per spec.
    return t('settings.voiceMicDeviceFallback', { defaultValue: 'Microphone {{n}}', n: index + 1 });
  };

  return (
    <div className='flex flex-col gap-8px'>
      <div className='flex items-center gap-12px flex-wrap'>
        <WaylandSelect
          size='small'
          value={selectedDeviceId}
          onChange={(value: string) => setSelectedDeviceId(value)}
          disabled={state === 'requesting' || state === 'live'}
          style={{ minWidth: 220 }}
        >
          <WaylandSelect.Option value={DEFAULT_DEVICE_ID}>
            {t('settings.voiceMicDeviceDefault', 'System default microphone')}
          </WaylandSelect.Option>
          {devices.map((device, index) => (
            <WaylandSelect.Option key={device.deviceId} value={device.deviceId}>
              {deviceOptionLabel(device, index)}
            </WaylandSelect.Option>
          ))}
        </WaylandSelect>
        <Button
          type='outline'
          size='small'
          icon={<Mic size={14} />}
          loading={state === 'requesting'}
          disabled={state === 'requesting' || state === 'live'}
          onClick={handleStart}
        >
          {buttonLabel}
        </Button>
        {state === 'live' && (
          <div className='flex-1 h-8px rd-full bg-[var(--color-fill-2)] overflow-hidden min-w-120px'>
            <div
              className='h-full bg-[rgb(var(--primary-6))] transition-[width] duration-75'
              style={{ width: `${level}%` }}
            />
          </div>
        )}
      </div>
      {state === 'done' && (
        <span className='text-12px text-[rgb(var(--success-6))]'>
          {t('settings.voiceMicWorking', 'Microphone is working.')}
        </span>
      )}
      {state === 'error' && <span className='text-12px text-[rgb(var(--danger-6))]'>{errorMsg}</span>}
    </div>
  );
};

export default MicrophoneCheck;
