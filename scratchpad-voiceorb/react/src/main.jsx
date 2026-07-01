import React from 'react';
import { createRoot } from 'react-dom/client';
import VoiceMode from './VoiceMode';
import OrbFilters from './OrbFilters';
import './index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* SVG filter defs mounted once, referenced by the orb via filter:url(#..) */}
    <OrbFilters />
    <VoiceMode />
  </React.StrictMode>
);
