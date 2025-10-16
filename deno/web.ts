// @ts-check

import { useState } from 'https://esm.sh/preact/hooks';
import { html, render } from 'https://esm.sh/htm/preact';
import { BlobWriter, HttpReader, TextReader, ZipWriter } from 'https://unpkg.com/@zip.js/zip.js/index.js';

function App(props: any) {
  const jsonl = useState(0);
  const [a, setA] = useState(0);
  return html`
    <button onClick="${() => setA(a + 1)}">+</button>
    <h1>Hello ${props.name} ${a}!</h1>
  `;
}

render(
  html`
    <${App} name="World" />
  `,
  document.body,
);
