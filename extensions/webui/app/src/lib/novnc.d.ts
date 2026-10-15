// The part of noVNC's RFB client (docs/API.md of @novnc/novnc 1.7) the Desktop panel uses; the package ships no types.
declare module "@novnc/novnc" {
  export type RFBOptions = {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    repeaterID?: string;
    wsProtocols?: string[];
  };

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);
    background: string;
    clipViewport: boolean;
    dragViewport: boolean;
    focusOnClick: boolean;
    resizeSession: boolean;
    scaleViewport: boolean;
    showDotCursor: boolean;
    viewOnly: boolean;
    qualityLevel: number;
    compressionLevel: number;
    clipboardPasteFrom(text: string): void;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    sendCtrlAltDel(): void;
  }
}
