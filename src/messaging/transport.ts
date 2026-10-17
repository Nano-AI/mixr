export type Transport = (phone: string, text: string) => Promise<void>;
let transport: Transport = async (phone, text) => {
  if (process.env.TRANSPORT !== 'console')
    throw Error('Messaging transport is not connected');
  console.log(`[console ${phone}] ${text}`);
};
export const setTransport = (fn: Transport): void => {
  transport = fn;
};
export const send: Transport = (phone, text) => transport(phone, text);
