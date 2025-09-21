// shopify-store-updater.js
// Kører dagligt for at opdatere store data i Shopify Files
// Kan køres via GitHub Actions, Vercel Cron, eller anden automation

// Load environment variables fra .env fil i development
if (process.env.NODE_ENV !== 'production') {
    try {
        require('dotenv').config();
        console.log('📁 Loaded .env file');
    } catch (e) {
        // dotenv er optional - fortsæt uden hvis ikke installeret
    }
}

const fetch = require('node-fetch');
const { google } = require('googleapis');

// ============================================
// KONFIGURATION - Opdater disse værdier
// ============================================

const CONFIG = {
    // Shopify credentials
    SHOPIFY_STORE: process.env.SHOPIFY_STORE || 'nordal-denmark-dkk.myshopify.com',
    SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN, // Gem i environment variable!
    
    // Google Sheets - HUSK at opdatere disse!
    GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || '1cDrpjLdUyvpKR1_1iPos94Q9q_kEDQR2IVMBBNAWe8w',
    GOOGLE_SHEET_NAME: process.env.GOOGLE_SHEET_NAME || 'store_finder_import',
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY, // Hent fra environment

};

// ============================================
// HENT DATA FRA GOOGLE SHEETS
// ============================================
async function fetchFromGoogleSheets() {
    console.log('📊 Henter data fra Google Sheets...');
    
    try {
        let response;
        
        if (CONFIG.USE_SERVICE_ACCOUNT) {
            // Brug Service Account (anbefalet for automation)
            const auth = new google.auth.GoogleAuth({
                credentials: JSON.parse(CONFIG.GOOGLE_SERVICE_ACCOUNT_KEY),
                scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
            });
            
            const sheets = google.sheets({ version: 'v4', auth });
            
            response = await sheets.spreadsheets.values.get({
                spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
                range: `${CONFIG.GOOGLE_SHEET_NAME}!A1:I1000`,
            });
        } else {
            // Brug API Key - simplere metode med fetch
            const range = `${CONFIG.GOOGLE_SHEET_NAME}!A1:I1000`;
            const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?key=${CONFIG.GOOGLE_API_KEY}`;
            
            console.log('📡 Henter fra URL (uden API key i log):', url.replace(/key=.*/, 'key=***'));
            
            const fetchResponse = await fetch(url);
            
            if (!fetchResponse.ok) {
                const error = await fetchResponse.text();
                throw new Error(`Google Sheets API fejl: ${fetchResponse.status} - ${error}`);
            }
            
            const data = await fetchResponse.json();
            response = { data };
        }
        
        const rows = response.data.values;
        
        if (!rows || rows.length === 0) {
            throw new Error('Ingen data fundet i Google Sheets');
        }
        
        // Konverter til JSON format
        const headers = rows[0];
        const stores = rows.slice(1).map(row => {
            const store = {};
            headers.forEach((header, index) => {
                store[header] = row[index] || '';
            });
            
            // Trim whitespace
            if (store.City) store.City = store.City.trim();
            if (store.Company) store.Company = store.Company.trim();
            if (store.Country) store.Country = store.Country.trim();
            
            return store;
        });
        
        console.log(`✅ Hentet ${stores.length} butikker fra Google Sheets`);
        return stores;
        
    } catch (error) {
        console.error('❌ Fejl ved hentning fra Google Sheets:', error);
        throw error;
    }
}

// ============================================
// UPLOAD TIL SHOPIFY FILES
// ============================================
async function uploadToShopify(stores) {
    console.log('📤 Uploader til Shopify Files...');
    
    try {
        // Konverter stores til JSON
        const jsonContent = JSON.stringify(stores);
        const base64Content = Buffer.from(jsonContent).toString('base64');
        
        console.log(`📦 Forbereder upload: ${stores.length} butikker (${(jsonContent.length / 1024).toFixed(1)} KB)`);
        
        // GraphQL mutation til at oprette/opdatere fil
        const mutation = `
            mutation fileCreate($files: [FileCreateInput!]!) {
                fileCreate(files: $files) {
                    files {
                        ... on GenericFile {
                            id
                            alt
                            createdAt
                            url
                        }
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }
        `;
        
        // Unik filnavn med timestamp for at sikre cache-busting
        const timestamp = new Date().toISOString().split('T')[0];
        
        const variables = {
            files: [{
                alt: `Store Locator Data - ${timestamp}`,
                contentType: "APPLICATION_JSON",
                filename: "stores.json",
                originalSource: `data:application/json;base64,${base64Content}`
            }]
        };
        
        console.log(`📡 Sender til Shopify: https://${CONFIG.SHOPIFY_STORE}/admin/api/2024-01/graphql.json`);
        
        // Send til Shopify
        const response = await fetch(
            `https://${CONFIG.SHOPIFY_STORE}/admin/api/2024-01/graphql.json`,
            {
                method: 'POST',
                headers: {
                    'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    query: mutation,
                    variables: variables
                })
            }
        );
        
        // Log response status
        console.log(`📨 Shopify response status: ${response.status} ${response.statusText}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Shopify API error response:', errorText);
            throw new Error(`Shopify API returned ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        
        // Log hele response for debugging
        console.log('📋 Shopify response:', JSON.stringify(result, null, 2));
        
        // Check for GraphQL errors
        if (result.errors) {
            console.error('❌ GraphQL errors:', JSON.stringify(result.errors, null, 2));
            throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
        }
        
        // Check for user errors
        if (result.data?.fileCreate?.userErrors?.length > 0) {
            const errors = result.data.fileCreate.userErrors;
            console.error('❌ Shopify user errors:', JSON.stringify(errors, null, 2));
            throw new Error(`Shopify fejl: ${errors.map(e => e.message).join(', ')}`);
        }
        
        if (result.data?.fileCreate?.files?.[0]) {
            const file = result.data.fileCreate.files[0];
            console.log('✅ Fil uploadet til Shopify:');
            console.log(`   ID: ${file.id}`);
            
            if (file.url) {
                console.log(`   URL: ${file.url}`);
                console.log('\n⚠️  HUSK at opdatere STORES_JSON_URL i din Store Locator til:');
                console.log(`   ${file.url}`);
            } else {
                // Fallback hvis url ikke returneres
                const cdnUrl = `/cdn/shop/files/stores.json`;
                console.log(`   Forventet URL: ${cdnUrl}`);
                console.log('\n⚠️  HUSK at opdatere STORES_JSON_URL i din Store Locator til:');
                console.log(`   '${cdnUrl}'`);
            }
            
            return file;
        } else {
            console.error('❌ Unexpected response structure:', JSON.stringify(result, null, 2));
            throw new Error('Ingen fil returneret fra Shopify - check response structure ovenfor');
        }
        
    } catch (error) {
        console.error('❌ Fejl ved upload til Shopify:', error);
        throw error;
    }
}

// ============================================
// ALTERNATIV: SLET GAMMEL FIL FØRST
// ============================================
async function deleteOldFile(filename = 'stores.json') {
    console.log('🗑️  Sletter gammel fil hvis den findes...');
    
    try {
        // Først find filen
        const searchQuery = `
            query {
                files(first: 10, query: "filename:${filename}") {
                    edges {
                        node {
                            id
                            filename
                            url
                        }
                    }
                }
            }
        `;
        
        const searchResponse = await fetch(
            `https://${CONFIG.SHOPIFY_STORE}/admin/api/2024-01/graphql.json`,
            {
                method: 'POST',
                headers: {
                    'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query: searchQuery })
            }
        );
        
        const searchResult = await searchResponse.json();
        const files = searchResult.data?.files?.edges || [];
        
        // Slet hver fil der matcher
        for (const edge of files) {
            const fileId = edge.node.id;
            
            const deleteMutation = `
                mutation fileDelete($input: FileDeleteInput!) {
                    fileDelete(input: $input) {
                        deletedFileIds
                        userErrors {
                            field
                            message
                        }
                    }
                }
            `;
            
            await fetch(
                `https://${CONFIG.SHOPIFY_STORE}/admin/api/2024-01/graphql.json`,
                {
                    method: 'POST',
                    headers: {
                        'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        query: deleteMutation,
                        variables: {
                            input: { id: fileId }
                        }
                    })
                }
            );
            
            console.log(`✅ Slettet gammel fil: ${edge.node.filename}`);
        }
        
    } catch (error) {
        console.error('⚠️  Kunne ikke slette gammel fil (ikke kritisk):', error.message);
    }
}

// ============================================
// HOVEDFUNKTION
// ============================================
async function main() {
    console.log('🚀 Starter Store Locator opdatering...');
    console.log(`📅 Timestamp: ${new Date().toISOString()}`);
    
    try {
        // 1. Hent data fra Google Sheets
        const stores = await fetchFromGoogleSheets();
        
        // 2. Valider data
        if (!stores || stores.length === 0) {
            throw new Error('Ingen butikker at uploade');
        }
        
        console.log(`📊 Klar til at uploade ${stores.length} butikker`);
        
        // 3. Slet gammel fil (valgfrit - kommenter ud hvis ikke ønsket)
        // await deleteOldFile();
        
        // 4. Upload til Shopify
        const file = await uploadToShopify(stores);
        
        console.log('\n✅ SUCCES! Store data er opdateret.');
        console.log(`📊 Total butikker: ${stores.length}`);
        
        // 5. Valgfrit: Send notifikation (email, Slack, etc.)
        // await sendNotification('Store Locator opdateret succesfuldt');
        
    } catch (error) {
        console.error('\n❌ FEJL i opdatering:', error);
        
        // Valgfrit: Send fejl-notifikation
        // await sendErrorNotification(error.message);
        
        process.exit(1);
    }
}

// ============================================
// HJÆLPEFUNKTION: Test forbindelse
// ============================================
async function testConnections() {
    console.log('🧪 Tester forbindelser...');
    
    // Test Google Sheets
    try {
        const sheets = await fetchFromGoogleSheets();
        console.log(`✅ Google Sheets OK (${sheets.length} butikker)`);
    } catch (error) {
        console.error('❌ Google Sheets fejl:', error.message);
    }
    
    // Test Shopify
    try {
        const response = await fetch(
            `https://${CONFIG.SHOPIFY_STORE}/admin/api/2024-01/shop.json`,
            {
                headers: {
                    'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN,
                }
            }
        );
        const shop = await response.json();
        console.log(`✅ Shopify OK (${shop.shop?.name})`);
    } catch (error) {
        console.error('❌ Shopify fejl:', error.message);
    }
}

// Kør scriptet
if (require.main === module) {
    // Hvis du vil teste forbindelser først, kør: node shopify-store-updater.js test
    if (process.argv[2] === 'test') {
        testConnections();
    } else {
        main();
    }
}

module.exports = { main, fetchFromGoogleSheets, uploadToShopify };