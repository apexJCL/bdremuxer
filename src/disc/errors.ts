// Errors raised by the DiscSource layer.
//
// IsoMountError / NoBdmvInIsoError are reserved for the ISO backend
// (specs/spec-iso.md §9). They live here so the preflight aggregator can
// match on them without pulling in the macOS implementation.

export class IsoMountError extends Error {
  constructor(message: string, readonly isoPath: string) {
    super(message);
    this.name = "IsoMountError";
  }
}

export class NoBdmvInIsoError extends Error {
  constructor(message: string, readonly isoPath: string) {
    super(message);
    this.name = "NoBdmvInIsoError";
  }
}

export class UnsupportedDiscInputError extends Error {
  constructor(message: string, readonly input: string) {
    super(message);
    this.name = "UnsupportedDiscInputError";
  }
}
