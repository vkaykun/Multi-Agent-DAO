// Test script for OpenAI API
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env.vela
const envPath = path.resolve(__dirname, '.env.vela');
const envConfig = dotenv.parse(fs.readFileSync(envPath));

// Set environment variables
for (const key in envConfig) {
  process.env[key] = envConfig[key];
}

const apiKey = process.env.OPENAI_API_KEY;
console.log('OpenAI API Key length:', apiKey?.length || 'Not found');
console.log('First 10 chars of API Key:', apiKey?.substring(0, 10) || 'N/A');

async function testOpenAI() {
  try {
    console.log('Attempting to call OpenAI API...');
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello! Can you hear me?" }
        ],
        max_tokens: 50
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}, message: ${await response.text()}`);
    }
    
    const data = await response.json();
    console.log('Success! Response:');
    console.log(data.choices[0].message.content);
  } catch (error) {
    console.error('Error calling OpenAI API:');
    console.error(error.message);
  }
}

testOpenAI(); 