import 'dotenv/config';

process.env.OLLAMA_BASE_URL = 'https://1sncx85ljg8nic-11434.proxy.runpod.net';

async function run() {
  const ollamaBase = process.env.OLLAMA_BASE_URL.replace(/\/$/, '');
  const ollamaModel = 'llama3.2';
  const systemPrompt = 'Extract candidate details from this CV. Respond with ONLY a JSON object: {full_name, email, phone, location, current_company, current_position, years_experience (integer), university, major, graduation_year, role_applied}. Phone numbers are Egyptian (MENA region).';
  const text = 'Omar Adly. Software Engineer at Google. Experience: 5 years. Email: omar@example.com Phone: 01012345678';
  
  console.log("Sending test payload to", ollamaBase);
  
  const res = await fetch(`${ollamaBase}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      system: systemPrompt,
      prompt: text,
      stream: false,
      format: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          location: { type: "string" },
          current_company: { type: "string" },
          current_position: { type: "string" },
          years_experience: { type: "number" },
          university: { type: "string" },
          major: { type: "string" },
          graduation_year: { type: "string" },
          role_applied: { type: "string" }
        },
        required: ["full_name"]
      },
      options: { temperature: 0, num_ctx: 16384 }
    })
  });
  console.log("Status:", res.status);
  const data = await res.json();
  console.log("RAW RESPONSE:", data.response);
}

run().catch(console.error);
