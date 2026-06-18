/* Validates the EIP-191 wallet-proof the worker uses: a valid signature recovers
 * to the claimed wallet; a tampered path or a spoofed wallet claim do not.
 * Run: npm run test:sign  (from cloudflare/agent-gate) */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';

const gateMessage = (wallet, pathname, issued) =>
  `StartupHub Agent Gate\nWallet: ${wallet}\nPath: ${pathname}\nIssued: ${issued}`;

const account = privateKeyToAccount(generatePrivateKey());
const wallet = account.address;
const pathname = '/api/v1/startups';
const issued = String(Math.floor(Date.now() / 1000));
const signature = await account.signMessage({ message: gateMessage(wallet, pathname, issued) });

// 1. honest proof recovers to the wallet
const recovered = await recoverMessageAddress({ message: gateMessage(wallet, pathname, issued), signature });
const valid = recovered.toLowerCase() === wallet.toLowerCase();

// 2. same signature replayed against a DIFFERENT path must not verify
const otherPath = await recoverMessageAddress({ message: gateMessage(wallet, '/api/v1/investors', issued), signature });
const pathBound = otherPath.toLowerCase() !== wallet.toLowerCase();

// 3. attacker claims a wallet they don't control, attaches our sig: recovered != claimed
const fake = '0x000000000000000000000000000000000000dEaD';
const spoof = await recoverMessageAddress({ message: gateMessage(fake, pathname, issued), signature });
const spoofRejected = spoof.toLowerCase() !== fake.toLowerCase();

console.log('wallet           :', wallet);
console.log('valid proof      :', valid);
console.log('path-bound (replay rejected):', pathBound);
console.log('wallet-spoof rejected       :', spoofRejected);
const allPass = valid && pathBound && spoofRejected;
console.log(allPass ? '\nALL CHECKS PASS' : '\nFAIL');
process.exit(allPass ? 0 : 1);
