// What the user sends, as any channel hands it to the core: the text (possibly empty) and any files that came with it,
// in whatever modality (a photo, a voice note, a video, a document). Channel-neutral and ours: a channel turns its own
// message into this, and the core decides what the model sees.

/** A file that came with a message. */
export type Attachment = { name: string; mimeType: string; data: Uint8Array };

export type Incoming = { text: string; attachments?: readonly Attachment[] };

/** What the model is given for a message: text, or text and images. Plain JSON, so it's kept durably until answered. */
export type Content = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
