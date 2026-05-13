// MakeMKV --robot output uses small integer codes for the kind of info
// being reported. The codes aren't formally documented; the values below
// are the conventional readings agreed across community parsers (ARM,
// MakeMKV-Automator, etc.). Treat anything not listed as opaque — the
// parser preserves it verbatim under its numeric code.

export const CINFO = {
  TYPE: 1,
  NAME: 2,
  METADATA_LANG_CODE: 28,
  VOLUME_NAME: 30,
  ORIGINAL_TITLE: 32,
} as const;

export const TINFO = {
  NAME: 2,
  CHAPTER_COUNT: 8,
  DURATION: 9,
  SIZE_HUMAN: 10,
  SIZE_BYTES: 11,
  SEGMENT_COUNT: 25,
  SEGMENT_MAP: 26,
  OUTPUT_FILENAME: 27,
  METADATA_LANG_CODE: 28,
  TREE_INFO: 30,
  PANEL_TITLE: 33,
} as const;

export const SINFO = {
  TYPE: 1,
  NAME: 2,
  LANG_CODE: 3,
  LANG_NAME: 4,
  CODEC_SHORT: 5,
  CODEC_LONG: 6,
  BITRATE: 13,
  CHANNELS: 14,
  SAMPLE_RATE: 17,
  VIDEO_SIZE: 19,
  ASPECT_RATIO: 20,
  FRAME_RATE: 21,
  STREAM_FLAGS: 22,
  MKV_FLAGS: 28,
  DESCRIPTION: 30,
  OUTPUT_FORMAT: 31,
  MKV_FLAGS_TEXT: 33,
  FORCED: 38,
} as const;
