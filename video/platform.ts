/**
 * What the frame renderer needs from its surroundings. The browser preview and the server export each
 * provide these, so both draw the same pixels through the same code.
 */

export type Ctx = CanvasRenderingContext2D;

export interface Picture {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export interface Platform {
  createCanvas(width: number, height: number): HTMLCanvasElement;
  loadImage(url: string): Promise<Picture>;
  /** Registers a font file under a family name. */
  loadFont(url: string, family: string): Promise<void>;
  /** A pixel buffer `drawPixels` can put on a canvas. */
  newImageData(data: Uint8ClampedArray, width: number, height: number): ImageData;
}

/** The current picture of a segment's video; null until one is available. */
export type FootageFrame = (segmentId: string) => Picture | null;
