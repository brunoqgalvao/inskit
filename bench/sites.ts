// Benchmark catalog. Tier A: public demo logins (full end-to-end, known result).
// Tier B: real popular login pages with a NONEXISTENT account: success means the outcome was understood.
// Tier C: the user's real accounts, manual only.

export type Expect = 'logged_in' | 'rejected' | 'code_requested' | 'understood';
export type Case = { id: string; tier: 'A' | 'B' | 'C'; url: string; username?: string; password?: string; expect: Expect; successText?: string; manual?: boolean; note?: string };

const A = (id: string, url: string, username: string, password: string, successText: string, expect: Expect = 'logged_in', note?: string): Case =>
  ({ id, tier: 'A', url, username, password, expect, successText, note });

export const CASES: Case[] = [
  A('the-internet', 'https://the-internet.herokuapp.com/login', 'tomsmith', 'SuperSecretPassword!', 'You logged into a secure area'),
  A('practicetest', 'https://practicetestautomation.com/practice-test-login/', 'student', 'Password123', 'Logged In Successfully'),
  A('saucedemo', 'https://www.saucedemo.com/', 'standard_user', 'secret_sauce', 'Products', 'logged_in', 'React SPA, logout hidden in a side menu'),
  A('orangehrm', 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login', 'Admin', 'admin123', 'Dashboard', 'logged_in', 'Vue SPA'),
  A('expandtesting', 'https://practice.expandtesting.com/login', 'practice', 'SuperSecretPassword!', 'You logged into a secure area'),
  A('quotes', 'https://quotes.toscrape.com/login', 'admin', 'admin', 'Logout'),
  A('authtest-simple', 'https://authenticationtest.com/simpleFormAuth/', 'simpleForm@authenticationtest.com', 'pa$$w0rd', 'Login Success'),
  A('authtest-multistep', 'https://authenticationtest.com/multiStepAuth/', 'multi@authenticationtest.com', 'pa$$w0rd', 'Login Success', 'logged_in', 'username and password on separate pages'),
  A('authtest-complex', 'https://authenticationtest.com/complexAuth/', 'complex@authenticationtest.com', 'pa$$w0rd', 'Login Success', 'logged_in', 'needs a select and a checkbox besides the credentials'),
  A('authtest-totp', 'https://authenticationtest.com/totpChallenge/', 'totp@authenticationtest.com', 'pa$$w0rd', '', 'code_requested', 'TOTP second factor'),
  A('applitools', 'https://demo.applitools.com/', 'demo-user', 'demo-pass', 'Financial Overview', 'logged_in', 'accepts any credentials'),
  A('the-internet-wrong', 'https://the-internet.herokuapp.com/login', 'tomsmith', 'wrong-password', '', 'rejected'),
  A('saucedemo-wrong', 'https://www.saucedemo.com/', 'standard_user', 'wrong-password', '', 'rejected'),
  A('orangehrm-wrong', 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login', 'Admin', 'wrong-password', '', 'rejected'),
  A('expandtesting-wrong', 'https://practice.expandtesting.com/login', 'practice', 'wrong-password', '', 'rejected'),
  A('practicetest-wrong', 'https://practicetestautomation.com/practice-test-login/', 'student', 'wrong-password', '', 'rejected'),
  A('authtest-simple-wrong', 'https://authenticationtest.com/simpleFormAuth/', 'simpleForm@authenticationtest.com', 'wrong-password', '', 'rejected'),
  ...([
    ['mercadolivre', 'https://www.mercadolivre.com/jms/mlb/lgz/login?platform_id=ML&go=https%3A%2F%2Fwww.mercadolivre.com.br%2F&loginType=explicit'],
    ['amazon-br', 'https://www.amazon.com.br/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com.br%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=brflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0'],
    ['google', 'https://accounts.google.com/signin'],
    ['microsoft', 'https://login.live.com/'],
    ['github', 'https://github.com/login'],
    ['gitlab', 'https://gitlab.com/users/sign_in'],
    ['linkedin', 'https://www.linkedin.com/login'],
    ['x', 'https://x.com/i/flow/login'],
    ['facebook', 'https://www.facebook.com/login'],
    ['instagram', 'https://www.instagram.com/accounts/login/'],
    ['reddit', 'https://www.reddit.com/login/'],
    ['netflix', 'https://www.netflix.com/br/login'],
    ['spotify', 'https://accounts.spotify.com/pt-BR/login'],
    ['dropbox', 'https://www.dropbox.com/login'],
    ['notion', 'https://www.notion.com/login'],
    ['atlassian', 'https://id.atlassian.com/login'],
    ['paypal', 'https://www.paypal.com/signin'],
    ['shopee', 'https://shopee.com.br/buyer/login'],
    ['aliexpress', 'https://login.aliexpress.com/'],
    ['ifood', 'https://www.ifood.com.br/entrar'],
    ['airbnb', 'https://www.airbnb.com.br/login'],
    ['booking', 'https://account.booking.com/sign-in'],
    ['zoom', 'https://zoom.us/signin'],
    ['figma', 'https://www.figma.com/login'],
    ['stripe', 'https://dashboard.stripe.com/login'],
    ['wordpress', 'https://wordpress.com/log-in'],
    ['hubspot', 'https://app.hubspot.com/login'],
    ['magalu', 'https://www.magazineluiza.com.br/cliente/login/'],
    ['americanas', 'https://www.americanas.com.br/login'],
    ['apple', 'https://account.apple.com/sign-in'],
  ] as const).map(([id, url]): Case => ({ id, tier: 'B', url, expect: 'understood' })),
  { id: 'my-mercadolivre', tier: 'C', url: 'https://www.mercadolivre.com/jms/mlb/lgz/login?platform_id=ML', expect: 'code_requested', manual: true },
  { id: 'my-amazon', tier: 'C', url: 'https://www.amazon.com.br/', expect: 'logged_in', manual: true },
];

