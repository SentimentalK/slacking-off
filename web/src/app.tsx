import { useRoute } from './router';
import { Replay } from './pages/Replay';
import { Shell } from './shell/Shell';

export function App() {
  const route = useRoute();

  if (route.name === 'replay') return <Replay />;
  return <Shell route={route} />;
}
