import { LabIcon } from '@jupyterlab/ui-components';

/**
 * Flask mark from the project logo (logo.png), hand-redrawn as a compact SVG
 * so the About dialog gets a crisp vector at any size. Brand colors are
 * sampled from the artwork; the white glass and navy outline match both the
 * light and dark logo variants, so no per-theme handling is needed.
 */
export const aboutLogoIcon = new LabIcon({
  name: 'xtralab:about-logo',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">
  <g transform="rotate(-10 20 26)">
    <defs>
      <linearGradient id="jp-xtralab-about-liquid" x1="10" y1="24" x2="31" y2="41" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#0A86F2"/>
        <stop offset="0.45" stop-color="#5B43B8"/>
        <stop offset="1" stop-color="#EE3F78"/>
      </linearGradient>
      <clipPath id="jp-xtralab-about-flask">
        <path d="M17 8V19L9.4 34.6C8.9 35.7 8.9 36.9 9.6 38C10.3 39.1 11.5 39.8 12.8 39.8L27.2 39.8C28.5 39.8 29.7 39.1 30.4 38C31.1 36.9 31.1 35.7 30.6 34.6L23 19V8Z"/>
      </clipPath>
    </defs>
    <path d="M17 8V19L9.4 34.6C8.9 35.7 8.9 36.9 9.6 38C10.3 39.1 11.5 39.8 12.8 39.8L27.2 39.8C28.5 39.8 29.7 39.1 30.4 38C31.1 36.9 31.1 35.7 30.6 34.6L23 19V8Z" fill="#fff"/>
    <rect x="6" y="24" width="36" height="19" fill="url(#jp-xtralab-about-liquid)" clip-path="url(#jp-xtralab-about-flask)"/>
    <circle cx="16.5" cy="31" r="1.5" fill="#fff" fill-opacity="0.85"/>
    <circle cx="21.5" cy="34.5" r="1.1" fill="#fff" fill-opacity="0.85"/>
    <circle cx="19" cy="27.5" r="0.8" fill="#fff" fill-opacity="0.85"/>
    <path d="M17 8V19L9.4 34.6C8.9 35.7 8.9 36.9 9.6 38C10.3 39.1 11.5 39.8 12.8 39.8L27.2 39.8C28.5 39.8 29.7 39.1 30.4 38C31.1 36.9 31.1 35.7 30.6 34.6L23 19V8Z" stroke="#354B69" stroke-width="2.6" stroke-linejoin="round"/>
    <path d="M15 7h10" stroke="#354B69" stroke-width="3" stroke-linecap="round"/>
    <circle cx="19.8" cy="21.2" r="1.5" fill="#0A86F2"/>
    <circle cx="20.4" cy="16" r="1.15" fill="#0A86F2"/>
    <circle cx="19.6" cy="11.2" r="0.85" fill="#0A86F2"/>
  </g>
  <rect x="26" y="12" width="5" height="5" rx="1.2" fill="#7649C0"/>
  <rect x="32.5" y="5.5" width="6.2" height="6.2" rx="1.4" fill="#0998F2"/>
  <rect x="40.5" y="1.5" width="3.8" height="3.8" rx="1" fill="#7649C0"/>
</svg>`
});
