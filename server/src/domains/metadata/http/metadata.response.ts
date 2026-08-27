export interface PrepareMetadataResponse {
  tokenId: number;
  metadataCid: string;
  tokenUri: string;
  ready: boolean;
}

export interface MetadataStatusResponse {
  tokenId: number;
  ready: boolean;
  tokenUri: string | null;
  dependencies: {
    cid: string;
    kind: string;
    pinStatus: string;
    preservationStatus: string;
  }[];
}
