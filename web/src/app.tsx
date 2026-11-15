import { useRoute } from './router';
import { Play } from './pages/Play';
import { Replay } from './pages/Replay';
import { Shell } from './shell/Shell';

export function App() {
  const route = useRoute();

  if (route.name === 'replay') return <Replay />;
  if (route.name === 'play') return <Play />;
  return <Shell route={route} />;
}
