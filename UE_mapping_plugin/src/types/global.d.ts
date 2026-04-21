interface Window {
  ue?: {
    aicartographerbridge?: {
      requestdeepscan: (nodeId: string, assetPath: string) => void;
      requestgraphdata: () => string;
      sendlogtoue: (msg: string) => void;
      pingbridge: () => string;
    };
  };
  receiveDeepScan?: (nodeId: string, astData: any) => void;
  receiveGlobalNodes?: (nodesData: any) => void;
}