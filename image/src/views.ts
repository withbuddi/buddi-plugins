/**
 * The picture on the canvas. `src` is the Files library id, never a URL: the
 * canvas builds the library's own URLs, as for `developer.screenshot`.
 */
import type { ViewDescriptor } from '@buddi/core/plugin';

export const imageViews: ViewDescriptor[] = [
  {
    tool: 'image.generate',
    renderer: 'image',
    title: 'Image',
    map: {
      src: 'id',
      title: { path: 'name' },
      // The owner reads what it was made from, folded; the result's
      // `forAgent` is the model's and is never drawn.
      caption: { path: 'prompt' },
      captionLabel: { const: 'Prompt' },
    },
  },
];
