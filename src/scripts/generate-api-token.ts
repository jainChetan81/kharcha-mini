import { generateToken, storeToken } from "../api/token";

function main(): void {
  const token = generateToken();
  storeToken(token);
  // eslint-disable-next-line no-console
  console.log("kharcha-mini-api-token generated and stored in Keychain.");
}

main();
