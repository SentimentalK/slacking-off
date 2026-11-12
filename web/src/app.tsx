import { useRoute } from './router';
import { Placeholder } from './pages/Placeholder';
import { Spectator } from './pages/Spectator';

export function App() {
  const route = useRoute();

  switch (route.name) {
    case 'spectator':
      return <Spectator />;
    case 'replay':
      return <Placeholder title="回放" note="时间轴和逐 tick 回放由 E3 接管。" />;
    case 'agent':
      return <Placeholder title={`Agent #${route.id}`} note="档案页由 E3 接管。" />;
    case 'leaderboard':
      return <Placeholder title="排行榜" note="带薪榜由 E3 接管。" />;
    case 'stats':
      return <Placeholder title="统计" note="统计页由 E3 接管。" />;
    default:
      return <Placeholder title="建设中" note={`${route.path} 还没有页面。`} />;
  }
}
