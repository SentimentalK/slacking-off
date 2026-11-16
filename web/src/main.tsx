import { render } from 'preact';
import { App } from './app';
import { initLang } from './i18n';
import { loadScene } from './sceneLoader';

void loadScene();
const root = document.getElementById('root');
initLang().then(
  () => {
    if (root) render(<App />, root);
  },
  (error: unknown) => {
    console.error('loading the dictionary failed', error);
    if (root) root.textContent = "Couldn't load the page text. Please reload.";
  },
);
