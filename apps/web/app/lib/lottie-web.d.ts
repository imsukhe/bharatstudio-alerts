// lottie-web ships no bundled types and no @types/lottie-web package
// exists on the public npm registry. This declares only the narrow
// subset of the runtime API this app actually calls.
declare module 'lottie-web' {
  export type AnimationItem = {
    destroy(): void;
  };

  export type AnimationConfig = {
    container: Element;
    renderer?: 'svg' | 'canvas' | 'html';
    loop?: boolean | number;
    autoplay?: boolean;
    animationData: unknown;
  };

  const lottie: {
    loadAnimation(config: AnimationConfig): AnimationItem;
  };

  export default lottie;
}
