import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { useKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const STORAGE_KEY_SESSIONS = 'focushour:sessions:v1';
const STORAGE_KEY_CONFIG = 'focushour:config:v1';

const DEFAULT_FOCUS_MIN = 25;
const DEFAULT_BREAK_MIN = 5;

type Mode = 'focus' | 'break';

type Session = {
  id: string;
  mode: Mode;
  durationSec: number;
  completedAt: number;
};

type Config = {
  focusMin: number;
  breakMin: number;
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  useKeepAwake();
  const [config, setConfig] = useState<Config>({ focusMin: DEFAULT_FOCUS_MIN, breakMin: DEFAULT_BREAK_MIN });
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>('focus');
  const [remainingSec, setRemainingSec] = useState(DEFAULT_FOCUS_MIN * 60);
  const [running, setRunning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const targetRef = useRef<number | null>(null);
  const notifIdRef = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [c, s] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY_CONFIG),
          AsyncStorage.getItem(STORAGE_KEY_SESSIONS),
        ]);
        let cfg = { focusMin: DEFAULT_FOCUS_MIN, breakMin: DEFAULT_BREAK_MIN };
        if (c) {
          cfg = JSON.parse(c);
          setConfig(cfg);
        }
        if (s) setSessions(JSON.parse(s));
        setRemainingSec(cfg.focusMin * 60);
      } catch (e) {
        console.warn('Load failed', e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(config)).catch(() => {});
  }, [config, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions)).catch(() => {});
  }, [sessions, loaded]);

  // Permission request on mount (notifications)
  useEffect(() => {
    (async () => {
      const settings = await Notifications.getPermissionsAsync();
      if (settings.status !== 'granted') {
        await Notifications.requestPermissionsAsync();
      }
    })();
  }, []);

  const totalSec = mode === 'focus' ? config.focusMin * 60 : config.breakMin * 60;

  const cancelScheduledNotif = useCallback(async () => {
    if (notifIdRef.current) {
      try {
        await Notifications.cancelScheduledNotificationAsync(notifIdRef.current);
      } catch {}
      notifIdRef.current = null;
    }
  }, []);

  const stopTick = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    targetRef.current = null;
  }, []);

  const completeSession = useCallback(() => {
    const completedAt = Date.now();
    const sec = totalSec;
    const finishedMode = mode;
    setSessions((prev) => [
      {
        id: `${completedAt}-${Math.random().toString(36).slice(2, 8)}`,
        mode: finishedMode,
        durationSec: sec,
        completedAt,
      },
      ...prev,
    ].slice(0, 200));
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    const nextMode: Mode = finishedMode === 'focus' ? 'break' : 'focus';
    setMode(nextMode);
    const nextSec = (nextMode === 'focus' ? config.focusMin : config.breakMin) * 60;
    setRemainingSec(nextSec);
    setRunning(false);
    stopTick();
  }, [mode, totalSec, config, stopTick]);

  const tick = useCallback(() => {
    if (targetRef.current == null) return;
    const left = Math.max(0, Math.round((targetRef.current - Date.now()) / 1000));
    setRemainingSec(left);
    if (left <= 0) {
      stopTick();
      completeSession();
    }
  }, [completeSession, stopTick]);

  const start = useCallback(async () => {
    if (running) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    const target = Date.now() + remainingSec * 1000;
    targetRef.current = target;
    setRunning(true);

    // Schedule a local notification at the end so the user is alerted even if
    // they background the app or the JS timer is paused.
    try {
      await cancelScheduledNotif();
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: mode === 'focus' ? 'Focus session done' : 'Break done',
          body: mode === 'focus' ? 'Take a short break.' : 'Back to focus.',
          sound: 'default',
        },
        trigger: { type: 'timeInterval' as any, seconds: Math.max(1, remainingSec), repeats: false },
      });
      notifIdRef.current = id;
    } catch (e) {
      // Notifications may not be granted; ignore.
    }

    tickRef.current = setInterval(tick, 250);
  }, [running, remainingSec, mode, cancelScheduledNotif, tick]);

  const pause = useCallback(() => {
    if (!running) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    stopTick();
    setRunning(false);
    cancelScheduledNotif();
  }, [running, stopTick, cancelScheduledNotif]);

  const reset = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    stopTick();
    cancelScheduledNotif();
    setRunning(false);
    setRemainingSec(totalSec);
  }, [stopTick, totalSec, cancelScheduledNotif]);

  const skip = useCallback(() => {
    stopTick();
    cancelScheduledNotif();
    setRunning(false);
    const nextMode: Mode = mode === 'focus' ? 'break' : 'focus';
    setMode(nextMode);
    setRemainingSec((nextMode === 'focus' ? config.focusMin : config.breakMin) * 60);
  }, [mode, config, stopTick, cancelScheduledNotif]);

  useEffect(() => {
    return () => {
      stopTick();
      cancelScheduledNotif();
    };
  }, [stopTick, cancelScheduledNotif]);

  // Today's session stats
  const todayCounts = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const ms = start.getTime();
    const today = sessions.filter((s) => s.completedAt >= ms);
    const focusCount = today.filter((s) => s.mode === 'focus').length;
    const totalMin = today
      .filter((s) => s.mode === 'focus')
      .reduce((sum, s) => sum + Math.round(s.durationSec / 60), 0);
    return { focusCount, totalMin };
  }, [sessions]);

  const progress = useMemo(() => {
    if (totalSec === 0) return 0;
    return 1 - remainingSec / totalSec;
  }, [remainingSec, totalSec]);

  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  const timeLabel = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.brand}>Focus <Text style={styles.brandItalic}>Hour</Text></Text>
        <Pressable
          onPress={() => setSettingsOpen(true)}
          style={({ pressed }) => [styles.settingsBtn, pressed && styles.settingsBtnPressed]}
          hitSlop={8}
        >
          <Text style={styles.settingsBtnText}>Settings</Text>
        </Pressable>
      </View>

      <View style={styles.body}>
        <Text style={styles.modeLabel}>{mode === 'focus' ? 'FOCUS' : 'BREAK'}</Text>

        <View style={styles.dialWrap}>
          <DialRing progress={progress} mode={mode} />
          <View style={styles.dialCenter} pointerEvents="none">
            <Text style={styles.timeText}>{timeLabel}</Text>
            <Text style={styles.timeSub}>{Math.round(totalSec / 60)} min</Text>
          </View>
        </View>

        <View style={styles.controls}>
          {!running ? (
            <Pressable
              onPress={start}
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
            >
              <Text style={styles.primaryBtnText}>Start</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={pause}
              style={({ pressed }) => [styles.primaryBtn, styles.primaryBtnPause, pressed && styles.primaryBtnPressed]}
            >
              <Text style={styles.primaryBtnText}>Pause</Text>
            </Pressable>
          )}
          <Pressable
            onPress={reset}
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}
          >
            <Text style={styles.secondaryBtnText}>Reset</Text>
          </Pressable>
          <Pressable
            onPress={skip}
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}
          >
            <Text style={styles.secondaryBtnText}>Skip</Text>
          </Pressable>
        </View>

        <View style={styles.stats}>
          <Stat label="Today" value={`${todayCounts.focusCount}`} sub="sessions" />
          <Stat label="Minutes" value={`${todayCounts.totalMin}`} sub="focused" />
          <Stat label="All time" value={`${sessions.filter((s) => s.mode === 'focus').length}`} sub="sessions" />
        </View>
      </View>

      <SettingsModal
        visible={settingsOpen}
        config={config}
        onSave={(next) => {
          setConfig(next);
          setRemainingSec((mode === 'focus' ? next.focusMin : next.breakMin) * 60);
          setSettingsOpen(false);
        }}
        onClose={() => setSettingsOpen(false)}
      />
    </SafeAreaView>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statSub}>{sub}</Text>
    </View>
  );
}

/**
 * A pure-CSS-ish progress ring built with overlapping squared-off arcs.
 * Avoids react-native-svg so we stay in Expo Go without extra deps.
 */
function DialRing({ progress, mode }: { progress: number; mode: Mode }) {
  const size = 280;
  const thickness = 8;
  const color = mode === 'focus' ? '#c75050' : '#3a8a8a';
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: thickness,
          borderColor: 'rgba(255,255,255,0.07)',
          position: 'absolute',
        }}
      />
      {/* Discrete tick marks around the ring give a typographic dial feel without SVG */}
      {Array.from({ length: 60 }).map((_, i) => {
        const angle = (i / 60) * 2 * Math.PI - Math.PI / 2;
        const inner = size / 2 - thickness - 8;
        const outer = inner + (i % 5 === 0 ? 14 : 8);
        const x1 = Math.cos(angle) * inner;
        const y1 = Math.sin(angle) * inner;
        const x2 = Math.cos(angle) * outer;
        const y2 = Math.sin(angle) * outer;
        const filled = i / 60 < progress;
        const length = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
        const tickAngleDeg = (angle * 180) / Math.PI + 90;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              width: i % 5 === 0 ? 2 : 1,
              height: length,
              backgroundColor: filled ? color : 'rgba(255,255,255,0.18)',
              left: size / 2 + mx - (i % 5 === 0 ? 1 : 0.5),
              top: size / 2 + my - length / 2,
              transform: [{ rotate: `${tickAngleDeg}deg` }],
            }}
          />
        );
      })}
    </View>
  );
}

function SettingsModal({
  visible,
  config,
  onSave,
  onClose,
}: {
  visible: boolean;
  config: Config;
  onSave: (c: Config) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(config);

  useEffect(() => {
    if (visible) setDraft(config);
  }, [visible, config]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Settings</Text>
          <ScrollView contentContainerStyle={{ paddingBottom: 8 }}>
            <Row
              label="Focus length (min)"
              value={draft.focusMin}
              onChange={(v) => setDraft({ ...draft, focusMin: v })}
              min={1}
              max={120}
            />
            <Row
              label="Break length (min)"
              value={draft.breakMin}
              onChange={(v) => setDraft({ ...draft, breakMin: v })}
              min={1}
              max={60}
            />
          </ScrollView>
          <View style={styles.modalActions}>
            <Pressable onPress={onClose} style={({ pressed }) => [styles.modalBtn, pressed && styles.modalBtnPressed]}>
              <Text style={styles.modalBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => onSave(draft)}
              style={({ pressed }) => [styles.modalBtn, styles.modalBtnPrimary, pressed && styles.modalBtnPrimaryPressed]}
            >
              <Text style={[styles.modalBtnText, styles.modalBtnTextPrimary]}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Row({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <TextInput
        value={text}
        onChangeText={(t) => {
          setText(t);
          const n = parseInt(t, 10);
          if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
        }}
        keyboardType="number-pad"
        style={styles.rowInput}
        maxLength={3}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#16151a' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 6, paddingBottom: 8,
  },
  brand: { fontSize: 18, fontWeight: '700', color: '#e8e6df', letterSpacing: 0.3 },
  brandItalic: { fontStyle: 'italic', color: '#c75050', fontWeight: '600' },
  settingsBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  settingsBtnPressed: { backgroundColor: '#26242c' },
  settingsBtnText: { color: '#a09e95', fontSize: 13, fontWeight: '500' },

  body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  modeLabel: { fontSize: 12, letterSpacing: 0.32 * 12, color: '#c75050', marginBottom: 32, fontWeight: '600' },
  dialWrap: { alignItems: 'center', justifyContent: 'center', marginBottom: 32 },
  dialCenter: {
    position: 'absolute', alignItems: 'center', justifyContent: 'center',
  },
  timeText: { fontSize: 64, color: '#e8e6df', fontVariant: ['tabular-nums'], fontWeight: '300', letterSpacing: -1 },
  timeSub: { fontSize: 12, color: '#6e6c66', marginTop: 4, letterSpacing: 0.18 * 12 },
  controls: { flexDirection: 'row', gap: 10, marginBottom: 36 },
  primaryBtn: {
    paddingHorizontal: 36, paddingVertical: 14, borderRadius: 999,
    backgroundColor: '#c75050',
  },
  primaryBtnPause: { backgroundColor: '#3a8a8a' },
  primaryBtnPressed: { opacity: 0.85 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600', letterSpacing: 0.5 },
  secondaryBtn: {
    paddingHorizontal: 18, paddingVertical: 14, borderRadius: 999,
    borderWidth: 1, borderColor: '#36343c',
  },
  secondaryBtnPressed: { backgroundColor: '#26242c' },
  secondaryBtnText: { color: '#c1bfb6', fontSize: 14, fontWeight: '500' },

  stats: { flexDirection: 'row', gap: 28 },
  stat: { alignItems: 'center' },
  statLabel: { fontSize: 10, color: '#7b786f', letterSpacing: 0.2 * 10, marginBottom: 4 },
  statValue: { fontSize: 24, color: '#e8e6df', fontWeight: '400' },
  statSub: { fontSize: 10, color: '#6e6c66', marginTop: 2, letterSpacing: 0.1 * 10 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: '#1f1e24', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 24, paddingBottom: 36,
  },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#e8e6df', marginBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a292f' },
  rowLabel: { color: '#c1bfb6', fontSize: 15 },
  rowInput: {
    minWidth: 56, textAlign: 'right',
    backgroundColor: '#26242c', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    color: '#e8e6df', fontSize: 16, fontVariant: ['tabular-nums'],
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
  modalBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: '#26242c' },
  modalBtnPressed: { backgroundColor: '#33313a' },
  modalBtnPrimary: { backgroundColor: '#c75050' },
  modalBtnPrimaryPressed: { backgroundColor: '#a84141' },
  modalBtnText: { color: '#c1bfb6', fontSize: 14, fontWeight: '600' },
  modalBtnTextPrimary: { color: '#fff' },
});
