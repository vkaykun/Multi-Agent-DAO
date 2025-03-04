// Debug script to investigate Discord client initialization issues

class DiscordAugmentedRuntime {
  toString() {
    return "Base DiscordAugmentedRuntime toString";
  }
  
  valueOf() {
    return "Base DiscordAugmentedRuntime valueOf";
  }
}

// Create a test object similar to our discordRuntime
const testRuntime = {
  agentId: "test-agent",
  voiceConnections: [],
  providers: [],
  getSetting: (key: string) => key === "DISCORD_API_TOKEN" ? "test-token" : null,
  
  // First attempt
  toString() {
    return `DiscordRuntime:${this.agentId}`;
  },
  
  valueOf() {
    return this.toString();
  }
};

console.log("============ TEST OBJECT CONVERSIONS ============");
console.log("Direct toString:", testRuntime.toString());
console.log("String concatenation:", "Prefix " + testRuntime);
console.log("String template:", `Template ${testRuntime}`);
console.log("JSON.stringify:", JSON.stringify({runtime: testRuntime}));

// Test with proxies and Symbol.toPrimitive
console.log("\n============ ENHANCED TEST OBJECT ============");
const enhancedRuntime = {
  ...testRuntime,
  [Symbol.toPrimitive](hint: string) {
    console.log(`Symbol.toPrimitive called with hint: ${hint}`);
    if (hint === 'string') {
      return `EnhancedDiscordRuntime:${this.agentId}`;
    }
    if (hint === 'number') {
      return 1;
    }
    return true;
  }
};

console.log("Direct toString:", enhancedRuntime.toString());
console.log("String concatenation:", "Prefix " + enhancedRuntime);
console.log("String template:", `Template ${enhancedRuntime}`);
console.log("JSON.stringify:", JSON.stringify({runtime: enhancedRuntime}));

// Let's try with a proxy
console.log("\n============ PROXY TEST OBJECT ============");
const handler = {
  get(target: any, prop: string | symbol) {
    if (prop === Symbol.toPrimitive) {
      return function(hint: string) {
        console.log(`Proxy Symbol.toPrimitive called with hint: ${hint}`);
        if (hint === 'string') {
          return `ProxyDiscordRuntime:${target.agentId}`;
        }
        if (hint === 'number') {
          return 1;
        }
        return true;
      };
    }
    return target[prop];
  }
};

const proxyRuntime = new Proxy(testRuntime, handler);
console.log("Direct toString:", proxyRuntime.toString());
console.log("String concatenation:", "Prefix " + proxyRuntime);
console.log("String template:", `Template ${proxyRuntime}`);
try {
  console.log("JSON.stringify:", JSON.stringify({runtime: proxyRuntime}));
} catch (e) {
  console.log("JSON.stringify error:", e.message);
}

// Test instanceof checks
console.log("\n============ INSTANCEOF CHECKS ============");
const dummyRuntime = new DiscordAugmentedRuntime();
console.log("dummyRuntime instanceof DiscordAugmentedRuntime:", dummyRuntime instanceof DiscordAugmentedRuntime);
console.log("testRuntime instanceof DiscordAugmentedRuntime:", testRuntime instanceof DiscordAugmentedRuntime); 