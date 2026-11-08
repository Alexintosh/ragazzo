# Nina and the star that lost its way

An original illustrated story and Character Card v2 for **Luma**, a gentle storyteller.
The three original illustrations were generated with OpenAI image generation for this example.
No external photographs or copyrighted characters are used.

Nina finds a small lost star in a lantern in the twilight forest. With help from an owl,
she follows its reflection from a footbridge to a grassy hill. There she opens the lantern
and the star finds its way home. The reader helps by choosing what Nina says and does.

## Use in Rakazo

Enable **Settings → General → Roleplay bots**, create an RP bot with `character.json`,
then add the three PNG files in the character's **Images** settings. Use the descriptions
and scene names in `album.json`. Enable images, set the normal interval to four turns and
the story interval to one. Spontaneous sharing is off for this example unless you explicitly enable it.

Alternatively, with a signed-in session cookie in `RAKAZO_SESSION_COOKIE`, run from the repository:

```sh
pnpm exec tsx examples/roleplay/nina-story/install.ts https://your-rakazo.example
```

The installer uses the ordinary authenticated API, enables RP for that account and uploads
the three illustrations. Re-running it does not replace an already installed character or story.
The cookie is not printed or written to disk. Docker must already be configured for RP.

## Try the flow

1. Say **“Mi racconti la storia di Nina con le immagini?”** Story mode should activate naturally,
   and the forest illustration should accompany the opening scene.
2. Ask **“Andiamo al ponte e chiediamo aiuto al gufo.”** The bridge illustration should accompany
   that transition, rather than repeating the forest image.
3. Say **“Accompagniamo Tilla sulla collina e lasciamola tornare nel cielo.”** The final image should appear.
4. Say **“Basta storia per adesso, facciamo due chiacchiere.”** Story mode should turn off.
5. Use **Story mode** in the bot sidebar to switch modes without sending a message.

Scene selection and wording are model decisions. The backend enforces album ownership,
valid image references, frequency limits and no accidental repeat sends. The three image files
are pre-generated assets; this example does not configure an image-generation endpoint.
