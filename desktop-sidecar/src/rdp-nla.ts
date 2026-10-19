import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";

// Network Level Authentication as a client (docs/remote.md, 「Credentials」): CredSSP carrying
// NTLMv2, which gnome-remote-desktop requires before anything else of RDP. The relay runs it toward
// the desktop with the console's kept password, so the browser, which never holds that password,
// is told the connection is plain TLS.
//
// CredSSP (MS-CSSP) is a DER TSRequest exchanged over the TLS connection:
//   TSRequest ::= SEQUENCE { version [0] INTEGER, negoTokens [1] SEQUENCE OF SEQUENCE { [0] OCTET STRING },
//                            authInfo [2] OCTET STRING, pubKeyAuth [3] OCTET STRING,
//                            errorCode [4] INTEGER, clientNonce [5] OCTET STRING }
// and NTLM (MS-NLMP) travels raw inside negoTokens.

const CREDSSP_VERSION = 6;

const NTLM_SIGNATURE = new TextEncoder().encode("NTLMSSP\0");

// UNICODE, REQUEST_TARGET, SIGN, SEAL, NTLM, ALWAYS_SIGN, EXTENDED_SESSIONSECURITY, VERSION, 128,
// KEY_EXCH, 56.
const NEGOTIATE_FLAGS = 0xe2088235;
// Windows 6.1 build 7601, NTLM revision 15: a version every server accepts.
const NTLM_VERSION = new Uint8Array([6, 1, 0xb1, 0x1d, 0, 0, 0, 0x0f]);

const AV_EOL = 0;
const AV_FLAGS = 6;
const AV_TIMESTAMP = 7;
const AV_FLAG_MIC = 0x2;

const CLIENT_BINDING_MAGIC = new TextEncoder().encode("CredSSP Client-To-Server Binding Hash\0");
const SIGN_MAGIC = new TextEncoder().encode("session key to client-to-server signing key magic constant\0");
const SEAL_MAGIC = new TextEncoder().encode("session key to client-to-server sealing key magic constant\0");

export class NlaError extends Error {
  // Whether the server refused the credentials, rather than the exchange going wrong.
  constructor(
    message: string,
    readonly refused = false
  ) {
    super(message);
  }
}

export interface NlaCredentials {
  username: string;
  password: string;
  domain?: string;
}

// ---- DER ----

function lengthBytes(length: number): number[] {
  if (length < 0x80) return [length];

  const bytes: number[] = [];

  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);

  return [0x80 | bytes.length, ...bytes];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

function der(tag: number, content: Uint8Array): Uint8Array {
  return concat([new Uint8Array([tag, ...lengthBytes(content.length)]), content]);
}

const sequence = (...parts: Uint8Array[]) => der(0x30, concat(parts));
const context = (tag: number, content: Uint8Array) => der(0xa0 | tag, content);
const octets = (content: Uint8Array) => der(0x04, content);

function integer(value: number): Uint8Array {
  const bytes = [value & 0xff];

  for (let rest = value >>> 8; rest > 0; rest >>>= 8) bytes.unshift(rest & 0xff);

  if (bytes[0]! & 0x80) bytes.unshift(0);

  return der(0x02, new Uint8Array(bytes));
}

interface Element {
  tag: number;
  content: Uint8Array;
  end: number;
}

function readElement(bytes: Uint8Array, at: number): Element {
  if (at + 2 > bytes.length) throw new NlaError("truncated element");

  const tag = bytes[at]!;
  let length = bytes[at + 1]!;
  let start = at + 2;

  if (length & 0x80) {
    const count = length & 0x7f;

    if (count === 0 || count > 4 || start + count > bytes.length) throw new NlaError("bad length");

    length = 0;

    for (let index = 0; index < count; index += 1) length = length * 256 + bytes[start + index]!;

    start += count;
  }

  if (start + length > bytes.length) throw new NlaError("element runs past its container");

  return { tag, content: bytes.subarray(start, start + length), end: start + length };
}

function readChildren(content: Uint8Array): Element[] {
  const out: Element[] = [];

  for (let at = 0; at < content.length; ) {
    const one = readElement(content, at);

    out.push(one);
    at = one.end;
  }

  return out;
}

// The length of one whole DER element at the front of a stream, or null while it is incomplete.
export function derLength(bytes: Uint8Array): number | null {
  if (bytes.length < 2) return null;

  const first = bytes[1]!;

  if (!(first & 0x80)) return 2 + first;

  const count = first & 0x7f;

  if (count === 0 || count > 4) throw new NlaError("bad length");
  if (bytes.length < 2 + count) return null;

  let length = 0;

  for (let index = 0; index < count; index += 1) length = length * 256 + bytes[2 + index]!;

  return 2 + count + length;
}

export interface TsRequest {
  version: number;
  negoToken?: Uint8Array;
  pubKeyAuth?: Uint8Array;
  errorCode?: number;
}

export function readTsRequest(bytes: Uint8Array): TsRequest {
  const top = readElement(bytes, 0);

  if (top.tag !== 0x30) throw new NlaError("not a TSRequest");

  const request: TsRequest = { version: 0 };

  for (const field of readChildren(top.content)) {
    const inner = readElement(field.content, 0);

    switch (field.tag) {
      case 0xa0:
        request.version = inner.content.reduce((sum, byte) => sum * 256 + byte, 0);
        break;
      case 0xa1: {
        const first = readChildren(inner.content)[0];
        const token = first ? readChildren(first.content)[0] : undefined;

        if (token) request.negoToken = readElement(token.content, 0).content;
        break;
      }
      case 0xa3:
        request.pubKeyAuth = inner.content;
        break;
      case 0xa4:
        request.errorCode = inner.content.reduce((sum, byte) => (sum * 256 + byte) >>> 0, 0);
        break;
    }
  }

  return request;
}

function tsRequest(fields: { negoToken?: Uint8Array; authInfo?: Uint8Array; pubKeyAuth?: Uint8Array; clientNonce?: Uint8Array }): Uint8Array {
  const parts = [context(0, integer(CREDSSP_VERSION))];

  if (fields.negoToken) parts.push(context(1, sequence(sequence(context(0, octets(fields.negoToken))))));
  if (fields.authInfo) parts.push(context(2, octets(fields.authInfo)));
  if (fields.pubKeyAuth) parts.push(context(3, octets(fields.pubKeyAuth)));
  if (fields.clientNonce) parts.push(context(5, octets(fields.clientNonce)));

  return sequence(...parts);
}

// The subjectPublicKey of a certificate's public key, as CredSSP binds it: the BIT STRING's
// content without its unused-bits byte, read out of the SubjectPublicKeyInfo.
export function subjectPublicKey(spki: Uint8Array): Uint8Array {
  const top = readElement(spki, 0);
  const bits = readChildren(top.content)[1];

  if (!bits || bits.tag !== 0x03 || bits.content.length < 1) throw new NlaError("no subject public key");

  return bits.content.subarray(1);
}

// ---- NTLM ----

function utf16(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf16le"));
}

function hmacMd5(key: Uint8Array, ...data: Uint8Array[]): Uint8Array {
  const mac = createHmac("md5", key);

  for (const one of data) mac.update(one);

  return new Uint8Array(mac.digest());
}

function md5(...data: Uint8Array[]): Uint8Array {
  const hash = createHash("md5");

  for (const one of data) hash.update(one);

  return new Uint8Array(hash.digest());
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function negotiateMessage(): Uint8Array {
  return concat([NTLM_SIGNATURE, new Uint8Array([...u32(1), ...u32(NEGOTIATE_FLAGS), ...new Array(16).fill(0)]), NTLM_VERSION]);
}

interface Challenge {
  flags: number;
  serverChallenge: Uint8Array;
  targetInfo: Uint8Array;
}

function readChallenge(bytes: Uint8Array): Challenge {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.length < 48 || view.getUint32(8, true) !== 2) throw new NlaError("not an NTLM challenge");

  const infoLength = view.getUint16(40, true);
  const infoOffset = view.getUint32(44, true);

  if (infoOffset + infoLength > bytes.length) throw new NlaError("challenge target info runs past it");

  return {
    flags: view.getUint32(20, true),
    serverChallenge: bytes.slice(24, 32),
    targetInfo: bytes.slice(infoOffset, infoOffset + infoLength)
  };
}

// The AV pairs of a target info, as id and value.
function avPairs(info: Uint8Array): { id: number; value: Uint8Array }[] {
  const out: { id: number; value: Uint8Array }[] = [];

  for (let at = 0; at + 4 <= info.length; ) {
    const id = info[at]! | (info[at + 1]! << 8);
    const length = info[at + 2]! | (info[at + 3]! << 8);

    if (id === AV_EOL) break;

    out.push({ id, value: info.subarray(at + 4, at + 4 + length) });
    at += 4 + length;
  }

  return out;
}

function encodeAvPairs(pairs: { id: number; value: Uint8Array }[]): Uint8Array {
  return concat([...pairs.flatMap((pair) => [new Uint8Array([...u16(pair.id), ...u16(pair.value.length)]), pair.value]), new Uint8Array(4)]);
}

// One direction's sealing state: an RC4 stream kept across messages, and the signing key.
class Sealer {
  private sequence = 0;
  private readonly rc4;

  constructor(
    private readonly signingKey: Uint8Array,
    sealingKey: Uint8Array
  ) {
    this.rc4 = createCipheriv("rc4", sealingKey, null);
  }

  // The sealed message with its signature in front, as CredSSP carries it.
  seal(message: Uint8Array): Uint8Array {
    const sequence = new Uint8Array(u32(this.sequence));
    const encrypted = new Uint8Array(this.rc4.update(message));
    const checksum = new Uint8Array(this.rc4.update(hmacMd5(this.signingKey, sequence, message).subarray(0, 8)));

    this.sequence += 1;

    return concat([new Uint8Array(u32(1)), checksum, sequence, encrypted]);
  }
}

function filetimeNow(): Uint8Array {
  // Hundreds of nanoseconds since 1601.
  const ticks = (BigInt(Date.now()) + BigInt(11_644_473_600_000)) * BigInt(10_000);
  const out = new Uint8Array(8);

  new DataView(out.buffer).setBigUint64(0, ticks, true);

  return out;
}

function securityBuffer(length: number, offset: number): number[] {
  return [...u16(length), ...u16(length), ...u32(offset)];
}

// The AUTHENTICATE message for a challenge, with the client's sealer for the messages after it.
export function authenticate(
  negotiate: Uint8Array,
  challengeBytes: Uint8Array,
  credentials: NlaCredentials,
  random: (size: number) => Uint8Array = (size) => new Uint8Array(randomBytes(size))
): { message: Uint8Array; sealer: Sealer } {
  const challenge = readChallenge(challengeBytes);
  const domain = credentials.domain ?? "";
  const pairs = avPairs(challenge.targetInfo);
  const timestamp = pairs.find((pair) => pair.id === AV_TIMESTAMP)?.value ?? filetimeNow();

  // The MIC is sent and said to be sent, which a server that stamped its challenge requires.
  const flags = pairs.find((pair) => pair.id === AV_FLAGS);
  const flagsValue = new Uint8Array(u32((flags ? new DataView(flags.value.buffer, flags.value.byteOffset, 4).getUint32(0, true) : 0) | AV_FLAG_MIC));
  const targetInfo = encodeAvPairs([...pairs.filter((pair) => pair.id !== AV_FLAGS), { id: AV_FLAGS, value: flagsValue }]);

  const ntHash = new Uint8Array(createHash("md4").update(utf16(credentials.password)).digest());
  const responseKey = hmacMd5(ntHash, utf16(credentials.username.toUpperCase() + domain));
  const clientChallenge = random(8);
  const temp = concat([new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0]), timestamp, clientChallenge, new Uint8Array(4), targetInfo, new Uint8Array(4)]);
  const proof = hmacMd5(responseKey, challenge.serverChallenge, temp);
  const ntResponse = concat([proof, temp]);
  const lmResponse = new Uint8Array(24);
  const keyExchangeKey = hmacMd5(responseKey, proof);
  const sessionKey = random(16);
  const encryptedKey = new Uint8Array(createCipheriv("rc4", keyExchangeKey, null).update(sessionKey));

  const domainBytes = utf16(domain);
  const userBytes = utf16(credentials.username);
  const workstation = utf16("");
  const header = 88;
  const payload = [lmResponse, ntResponse, domainBytes, userBytes, workstation, encryptedKey];
  const offsets: number[] = [];
  let offset = header;

  for (const part of payload) {
    offsets.push(offset);
    offset += part.length;
  }

  const fixed = new Uint8Array([
    ...u32(3),
    ...securityBuffer(lmResponse.length, offsets[0]!),
    ...securityBuffer(ntResponse.length, offsets[1]!),
    ...securityBuffer(domainBytes.length, offsets[2]!),
    ...securityBuffer(userBytes.length, offsets[3]!),
    ...securityBuffer(workstation.length, offsets[4]!),
    ...securityBuffer(encryptedKey.length, offsets[5]!),
    ...u32(NEGOTIATE_FLAGS & challenge.flags)
  ]);
  const message = concat([NTLM_SIGNATURE, fixed, NTLM_VERSION, new Uint8Array(16), ...payload]);

  message.set(hmacMd5(sessionKey, negotiate, challengeBytes, message), 72);

  return { message, sealer: new Sealer(md5(sessionKey, SIGN_MAGIC), md5(sessionKey, SEAL_MAGIC)) };
}

// ---- CredSSP ----

// The client's side of CredSSP as a sequence of steps: each takes what the server sent (nothing for
// the first) and says what to send, until it is done.
export function createNlaClient(
  credentials: NlaCredentials,
  serverPublicKey: Uint8Array,
  random: (size: number) => Uint8Array = (size) => new Uint8Array(randomBytes(size))
) {
  const negotiate = negotiateMessage();
  let sealer: Sealer | null = null;
  let step: "start" | "challenge" | "pubkey" | "done" = "start";

  function tsCredentials(): Uint8Array {
    const password = sequence(
      context(0, octets(utf16(credentials.domain ?? ""))),
      context(1, octets(utf16(credentials.username))),
      context(2, octets(utf16(credentials.password)))
    );

    return sequence(context(0, integer(1)), context(1, octets(password)));
  }

  return {
    // What to send first.
    start(): Uint8Array {
      step = "challenge";

      return tsRequest({ negoToken: negotiate });
    },
    // What to send for the server's next TSRequest, and whether that was the last.
    next(received: Uint8Array): { send: Uint8Array; done: boolean } {
      const request = readTsRequest(received);

      if (request.errorCode !== undefined) throw new NlaError(`server refused: 0x${request.errorCode.toString(16).padStart(8, "0")}`, true);

      if (step === "challenge") {
        if (!request.negoToken) throw new NlaError("no NTLM challenge");

        const nonce = random(32);
        const signed = authenticate(negotiate, request.negoToken, credentials, random);
        const hash = new Uint8Array(createHash("sha256").update(CLIENT_BINDING_MAGIC).update(nonce).update(serverPublicKey).digest());

        sealer = signed.sealer;
        step = "pubkey";

        return { send: tsRequest({ negoToken: signed.message, pubKeyAuth: sealer.seal(hash), clientNonce: nonce }), done: false };
      }

      if (step === "pubkey") {
        if (!request.pubKeyAuth || !sealer) throw new NlaError("no public key answer");

        step = "done";

        return { send: tsRequest({ authInfo: sealer.seal(tsCredentials()) }), done: true };
      }

      throw new NlaError("nothing more to send");
    }
  };
}
