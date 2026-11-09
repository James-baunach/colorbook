// Finds people, pets, etc. in a photo using a free model that runs in the
// browser (MediaPipe DeepLab v3, ~3 MB, downloaded once then cached).
// Returns a grayscale mask canvas: white = subject, black = background.

const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite';

// DeepLab (Pascal VOC) classes that count as "the subject" of a family photo
// 0 background, 1 aeroplane, 2 bicycle, 3 bird, 4 boat, 5 bottle, 6 bus, 7 car,
// 8 cat, 9 chair, 10 cow, 11 dining table, 12 dog, 13 horse, 14 motorbike,
// 15 person, 16 potted plant, 17 sheep, 18 sofa, 19 train, 20 tv
const SUBJECT = new Set([1, 2, 3, 4, 6, 7, 8, 10, 12, 13, 14, 15, 17, 19]);

let segmenterPromise = null;

function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import(`${VISION_URL}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
      return ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })().catch((err) => {
      segmenterPromise = null;
      throw err;
    });
  }
  return segmenterPromise;
}

// Returns a Blob (PNG) of the subject mask, or null if nothing was found.
export async function subjectMask(blob) {
  const seg = await getSegmenter();
  const bmp = await createImageBitmap(blob);
  // DeepLab works at 257x257 internally; give it a modest canvas
  const s = 512 / Math.max(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();

  const result = seg.segment(c);
  const mask = result.categoryMask;
  const labels = mask.getAsUint8Array();
  const mw = mask.width, mh = mask.height;
  const out = document.createElement('canvas');
  out.width = mw;
  out.height = mh;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(mw, mh);
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    const v = SUBJECT.has(labels[i]) ? 255 : 0;
    if (v) count++;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  result.close();
  ctx.putImageData(img, 0, 0);
  if (count < labels.length * 0.005) return null; // no clear subject
  return new Promise((r) => out.toBlob(r, 'image/png'));
}
