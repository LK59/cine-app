// The Matroska element ids this demuxer understands. Named rather than inlined so the parser
// below reads as structure instead of as magic numbers.

export const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,

  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,

  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,

  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  TrackName: 0x536e,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  FlagEnabled: 0xb9,

  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,
  Colour: 0x55b0,
  MatrixCoefficients: 0x55b1,
  TransferCharacteristics: 0x55ba,
  Primaries: 0x55bb,
  ColourRange: 0x55b9,
  /** The brightest and dimmest the content itself ever gets, in nits. Often absent. */
  MaxCll: 0x55bc,
  MaxFall: 0x55bd,
  /** How bright the display it was graded on could go. This is what a tone map normalises to. */
  MasteringMetadata: 0x55d0,
  LuminanceMax: 0x55d9,
  LuminanceMin: 0x55da,
  BitsPerChannel: 0x55b2,

  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  OutputSamplingFrequency: 0x78b5,
  Channels: 0x9f,
  AudioBitDepth: 0x6264,

  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  CueRelativePosition: 0xf0,

  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
} as const;

export const TRACK_TYPE = { video: 1, audio: 2, subtitle: 17 } as const;
