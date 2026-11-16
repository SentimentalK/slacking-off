import { useI18n } from './i18n';
import { useRoute } from './router';
import { Shell } from './shell/Shell';

export function App() {
  useI18n();
  const route = useRoute();

  return <Shell route={route} />;
}
