import { render } from 'preact';
import { App } from './app';
import { initLang } from './i18n';
import { loadScene } from './sceneLoader';

void loadScene();
const root = document.getElementById('root');
void initLang()
  .catch((error: unknown) => console.error('loading the dictionary failed', error))
  .then(() => {
    if (root) render(<App />, root);
  });
