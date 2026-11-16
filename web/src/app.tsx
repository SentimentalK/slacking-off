import { useRoute } from './router';
import { Shell } from './shell/Shell';

export function App() {
  const route = useRoute();

  return <Shell route={route} />;
}
