import { render } from 'preact';
import './styles.css';
import { App } from './app';
import { ensureSprites } from './sprites';
import { loadScene } from './sceneLoader';

const root = document.getElementById('root');
void loadScene();
if (root) {
  // Sprites are prerendered once; the first paint waits for them so the board
  // never flashes empty tiles.
  void ensureSprites().then(() => render(<App />, root));
}
