
export function uBitConnectDevice(eventHandler: (reason: any, device: any, data: any) => void): Promise<void>;

export function uBitDisconnect(device: any): Promise<void>;

export function uBitSend(device: any, data: string): Promise<void>;