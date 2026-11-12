import { useRoute } from './router';
import { Leaderboard } from './pages/Leaderboard';
import { Placeholder } from './pages/Placeholder';
import { Profile } from './pages/Profile';
import { Replay } from './pages/Replay';
import { Spectator } from './pages/Spectator';
import { Stats } from './pages/Stats';

export function App() {
  const route = useRoute();

  switch (route.name) {
    case 'spectator':
      return <Spectator />;
    case 'replay':
      return <Replay />;
    case 'agent':
      return <Profile id={route.id} />;
    case 'leaderboard':
      return <Leaderboard />;
    case 'stats':
      return <Stats />;
    default:
      return <Placeholder title="建设中" note={`${route.path} 还没有页面。`} />;
  }
}
