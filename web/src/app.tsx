import { useRoute } from './router';
import { Account } from './pages/Account';
import { Leaderboard } from './pages/Leaderboard';
import { Login } from './pages/Login';
import { Placeholder } from './pages/Placeholder';
import { Profile } from './pages/Profile';
import { Register } from './pages/Register';
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
    case 'login':
      return <Login />;
    case 'register':
      return <Register />;
    case 'account':
      return <Account />;
    default:
      return <Placeholder title="建设中" note={`${route.path} 还没有页面。`} />;
  }
}
