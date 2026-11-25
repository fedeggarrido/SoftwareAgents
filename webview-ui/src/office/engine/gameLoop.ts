import { MAX_DELTA_TIME_SEC } from '../../constants.js';

/** @internal */
export interface GameLoopCallbacks {
  update: (dt: number) => void;
  render: (ctx: CanvasRenderingContext2D) => void;
}

export interface GameLoop {
  /** Draw now: resizing clears the canvas, and a background tab may not get a frame for seconds. */
  redraw: () => void;
  stop: () => void;
}

export function startGameLoop(canvas: HTMLCanvasElement, callbacks: GameLoopCallbacks): GameLoop {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  let lastTime = 0;
  let rafId = 0;
  let stopped = false;

  const redraw = () => {
    ctx.imageSmoothingEnabled = false;
    callbacks.render(ctx);
  };

  const frame = (time: number) => {
    if (stopped) return;
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC);
    lastTime = time;

    callbacks.update(dt);

    redraw();

    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  return {
    redraw,
    stop: () => {
      stopped = true;
      cancelAnimationFrame(rafId);
    },
  };
}
