import { useEffect, useRef, useState } from 'preact/hooks';
import { navigate } from '../router';
import type { Route } from '../router';
import type { ClickHit } from '../world3d';
import { BottomWatch } from './BottomWatch';
import { Card } from './Card';
import { Feed } from './Feed';
import { PlayMode } from './PlayMode';
import { Settings } from './Settings';
import { TopBar } from './TopBar';
import { Window } from './Window';
import { WindowBody, windowTitle } from './windowContent';
import { modeBase, windowOf } from './route';
import type { Mode } from './route';
import { useWorld } from './useWorld';
import type { WorldOverride } from './useWorld';
import './ui.css';

const TOAST_MS = 4000;

export function Shell({ route }: { route: Route }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const override = useRef<WorldOverride | null>(null);
  const clickRef = useRef<((hit: ClickHit) => void) | null>(null);
  const cameraRef = useRef<(() => void) | null>(null);
  const world = useWorld(canvasRef, override, clickRef, cameraRef);
  const [mode, setMode] = useState<Mode>(route.name === 'play' ? 'play' : 'watch');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (route.name === 'spectator') setMode('watch');
    if (route.name === 'play') setMode('play');
    setSettingsOpen(false);
  }, [route]);

  useEffect(() => {
    if (route.name !== 'unknown') return;
    setToast(route.path);
    const timer = window.setTimeout(() => {
      setToast(null);
      window.history.replaceState(null, '', '/');
    }, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [route]);

  const ui = new URLSearchParams(location.search).get('ui') !== '0';
  const w = windowOf(route);
  const tick = world.projection?.tick ?? 0;
  const agent = world.projection?.agents.find((entry) => entry.id === world.selected) ?? null;
  const blocked = Boolean(w) || settingsOpen;

  return (
    <div class="shell">
      <canvas class="ui-canvas" data-renderer="3d" ref={canvasRef} role="img" aria-label={world.boardLabel} />
      <div class="ui-vig" />
      {ui ? (
        <>
          <TopBar
            status={world.status}
            replaying={world.mode === 'replay'}
            projection={world.projection}
            arrivedAt={world.arrivedAt}
            current={world.mode === 'replay' ? 'replay' : mode}
            onSettings={() => setSettingsOpen(true)}
            hideClock={mode === 'play'}
          />
          {mode === 'play' ? (
            <PlayMode
              terrain={world.terrain}
              top3={world.top3}
              view={world.view}
              override={override}
              clickRef={clickRef}
              cameraRef={cameraRef}
              blocked={blocked}
            />
          ) : (
            <>
              <Feed events={world.events} colors={world.colors} />
              <Card agent={agent} tick={tick} top3={world.top3} onVision={world.setVision} />
              <BottomWatch
                queue={world.projection?.queue ?? []}
                replay={world.mode === 'replay' ? world.replay : null}
              />
            </>
          )}
        </>
      ) : null}
      {w ? (
        <Window
          key={`${w.key}:${w.id ?? ''}`}
          title={windowTitle(w)}
          windowKey={w.key}
          onClose={() => navigate(modeBase(mode))}
        >
          <WindowBody w={w} />
        </Window>
      ) : settingsOpen ? (
        <Window title="设置" windowKey="settings" onClose={() => setSettingsOpen(false)}>
          <Settings
            dusk={world.dusk}
            onDusk={world.toggleDusk}
            quality={world.quality}
            onQuality={world.setQuality}
          />
        </Window>
      ) : null}
      {toast !== null ? <div class="ui-toast panel">没有这个页面：{toast}</div> : null}
    </div>
  );
}
