# Writing an image prompt

One request from the owner (or a colleague) becomes **one** prompt and **one**
call to `image.generate`. Write the prompt as a single paragraph, in this order:

1. **Subject.** What is in the picture, concretely: who or what, doing what,
   where. "A red fox curled asleep on a mossy stone" — not "a nice animal".
2. **Style.** The medium and the look: flat vector illustration, watercolour,
   35 mm photograph, isometric 3D render, ink sketch. One style, not three.
3. **Composition.** Framing and viewpoint: close-up, wide shot, from above,
   centred subject with empty space on the left for a title.
4. **Palette and light.** Two or three colours or a named mood: muted earth
   tones, soft morning light, high-contrast neon.
5. **What to avoid.** Say it plainly at the end: "no text, no logos, no
   watermark, no extra limbs".

**When the style matters, say it twice.** Image models drift toward detailed,
realistic rendering. State the style at the start *and* again at the end, and
name what it is not: "Flat vector illustration of … Flat vector, clean shapes,
no painterly texture, no photographic lighting, no gradients."

**No text in the image** unless the request asks for words; then quote them
exactly and keep them short. Image models misspell long text.

**Aspect.** `square` by default; `portrait` for posters and phone screens,
`landscape` for banners, slides and headers.

**References.** When the request comes with pictures (Files library ids), pass
them as `references` (at most four) and say in the prompt what to take from
them: "keep the character's shape and colours from the reference; new pose".

**Do not**:

- invent a brand's assets — a real company's logo, mascot, packaging or
  typeface — or draw a picture meant to pass as theirs;
- imitate a real, identifiable person, or draw someone "in the style of" a
  living artist by name;
- generate more than once for one request. If the result may be wrong, say so
  and let the owner ask again.

**After the call.** You cannot see the picture. Say in one or two sentences
what you **asked for** (subject, style, aspect) — "I asked for a flat-vector
fox…", never "I generated a flat-vector fox…" or a description of the result —
and give the library id and file name from the result. Never describe details
of the image as if you had seen it: the model may not have followed the prompt,
and only the owner can see whether it did.
