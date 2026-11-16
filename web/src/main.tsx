import { render } from 'preact';
import { App } from './app';
import { initLang } from './i18n';
import { loadScene } from './sceneLoader';

initLang();
void loadScene();
const root = document.getElementById('root');
if (root) render(<App />, root);
