import { render } from 'preact';
import { App } from './app';
import { loadScene } from './sceneLoader';

void loadScene();
const root = document.getElementById('root');
if (root) render(<App />, root);
