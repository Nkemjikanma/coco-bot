import type { QuestionType } from "../types";

// ============================================
// ENS Knowledge Base
// ============================================
// Pre-written answers for common ENS questions.
// For "general" questions, we'll use Claude to generate answers.

export const ENS_KNOWLEDGE: Record<Exclude<QuestionType, "general">, string> = {
  pricing: `💰 **ENS Pricing**

The yearly cost depends on the name length:

• **5+ characters:** $5/year
• **4 characters:** $160/year
• **3 characters:** $640/year

Plus you'll pay gas fees for the transaction (varies with network activity).

_Tip: Longer names are much cheaper! A 5-letter name for 10 years costs only $50 + gas._`,

  duration: `📅 **ENS Registration Duration**

• **Minimum:** 1 year
• **Maximum:** No limit! (but most interfaces cap at 10 years)

**Good to know:**
• You can renew anytime — even before expiration
• After expiration, there's a 90-day grace period where only you can renew
• After the grace period, the name goes to auction

_Tip: Registering for multiple years saves on gas fees since you only pay once!_`,

  records: `📋 **ENS Records**

You can store lots of info on your ENS name:

**Addresses:**
• ETH address (for receiving payments)
• BTC, LTC, and other crypto addresses

**Profile Info:**
• Twitter/X handle
• GitHub username
• Email address
• Website URL
• Avatar (image URL or NFT)
• Description/bio

**Advanced:**
• Content hash (for IPFS websites)
• Custom text records

_Your ENS name becomes your web3 identity!_`,

  process: `🔄 **How ENS Registration Works**

1. Easiest is to tag me in a message or using slash commands with the ENS name(s), duration and action you want to perfom
SUPPORTED ACTIONS:
- check: Check if name(s) are available
- register: Register new name(s)
- renew: Renew existing name(s)
- transfer: Transfer name to another address
- set: Set records (address, twitter, avatar, etc.)
- subdomain: Add new subdomain to ENS name
- portfolio: View user's ENS names
- expiry: Check expiry of given ENS name
- history: Check registration history of ENS name
- remind: Set reminder for ENS name renewal
- watch: Watch for when ENS name becomes available
- question: User is asking a QUESTION about ENS (not trying to do an action)
- help: User wants to see available commands


EXAMPLES:
Input: "check if alice.eth is available"
Output: {"action":"check","names":["alice.eth"]}

Input: "register bob.eth for 3 years"
Output: {"action":"register","names":["bob.eth"],"duration":3}

Input: "What's the minimum registration time?"
Output: {"action":"question","questionType":"duration","questionText":"What's the minimum registration time?"}

Input: "How much does a 3-letter name cost?"
Output: {"action":"question","questionType":"pricing","questionText":"How much does a 3-letter name cost?"}

Input: "What can I store in ENS records?"
Output: {"action":"question","questionType":"records","questionText":"What can I store in ENS records?"}

Input: "How does ENS registration work?"
Output: {"action":"question","questionType":"process","questionText":"How does ENS registration work?"}

Input: "What is ENS?"
Output: {"action":"question","questionType":"general","questionText":"What is ENS?"}

Input: "buy alice.eth and bob.eth for 5 years"
Output: {"action":"register","names":["alice.eth","bob.eth"],"duration":5,"options":{"batch":true}}

Input: "renew my domains"
Output: {"action":"renew","names":[],"options":{"filter":"all"}}

Input: "transfer alice.eth to 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
Output: {"action":"transfer","names":["alice.eth"],"recipient":"0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"}

Input: "set my twitter to @alice on myname.eth"
Output: {"action":"set","names":["myname.eth"],"records":{"twitter":"@alice"}}

Input: "show my portfolio"
Output: {"action":"portfolio","names":[]}

Input: "what can you do?" or "help"
Output: {"action":"help","names":[]}

Input: "do something"
Output: {"action":"help","needsClarification":true,"clarificationQuestion":"What would you like to do? I can check availability, register names, renew, transfer, or set records."}

2. Or through the long and tiring 3-step process:

**Step 1: Commit (hidden)**
Your intent to register is recorded on-chain, but the name is hidden. This prevents others from front-running you.

**Step 2: Wait (~1 minute)**
A short waiting period ensures your commitment is secure.

**Step 3: Register**
Complete the registration and the name is yours!

**What you'll need:**
• ETH for the registration fee + gas
• A wallet (like MetaMask or Towns wallet)

_The whole process takes about 2-3 minutes!_`,

  subdomains: `🏷️ **ENS Subdomains**

Subdomains let you create names under your existing ENS name!

**Example:**
- You own: alice.eth
- You can create: blog.alice.eth, mail.alice.eth, wallet.alice.eth

**Key Facts:**
- **Free to create** - no registration fee (just gas)
- **You control them** - create, delete, or transfer anytime
- **Inherit parent** - they work as long as alice.eth is valid
- **Unlimited** - create as many as you want

**Use Cases:**
- **Wallet organization:** vault.alice.eth, hot.alice.eth, cold.alice.eth
- **Projects:** dao.alice.eth, nft.alice.eth
- **Family/team:** mom.alice.eth, partner.alice.eth
- **Services:** mail.alice.eth, blog.alice.eth

**Common Use Cases:**
• **Wallet organization:** vault.alice.eth, hot.alice.eth, cold.alice.eth
• **Projects:** dao.alice.eth, nft.alice.eth
• **Family/team:** mom.alice.eth, partner.alice.eth
• **Services:** mail.alice.eth, blog.alice.eth

**Requirements:**
• You must own the parent name (alice.eth)
• Parent should be "wrapped" for best features
• Single transaction (no commit-reveal like top-level names)

_Tip: Subdomains are great for organizing your web3 life without buying multiple names!_
_You must own the parent name to create subdomains under it._`,
};
