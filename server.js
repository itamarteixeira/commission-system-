const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xml2js = require('xml2js');
const pdfParse = require('pdf-parse');
const { Pool } = require('pg');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('public'));

// PostgreSQL Pool Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Test connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Erro ao conectar PostgreSQL:', err);
  } else {
    console.log('✅ PostgreSQL conectado com sucesso!');
    release();
    initDatabase();
  }
});

// Initialize database tables
async function initDatabase() {
  const client = await pool.connect();
  try {
    console.log('📦 Criando tabelas PostgreSQL...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS notas_fiscais (
        id SERIAL PRIMARY KEY,
        numero_nota TEXT NOT NULL,
        serie TEXT,
        data_emissao TEXT,
        chave_acesso TEXT UNIQUE,
        emitente_nome TEXT,
        emitente_cnpj TEXT,
        destinatario_nome TEXT,
        destinatario_cnpj TEXT,
        valor_total DECIMAL(10,2),
        xml_completo TEXT,
        data_importacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS duplicatas (
        id SERIAL PRIMARY KEY,
        nota_fiscal_id INTEGER REFERENCES notas_fiscais(id) ON DELETE CASCADE,
        numero_duplicata TEXT,
        valor DECIMAL(10,2),
        vencimento TEXT,
        previsao_recebimento TEXT,
        data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS titulos_comissao (
        id SERIAL PRIMARY KEY,
        duplicata_id INTEGER REFERENCES duplicatas(id) ON DELETE CASCADE,
        nota_fiscal_id INTEGER REFERENCES notas_fiscais(id) ON DELETE CASCADE,
        percentual_comissao DECIMAL(5,2),
        valor_comissao DECIMAL(10,2),
        status TEXT DEFAULT 'pendente',
        status_pagamento TEXT DEFAULT 'pendente',
        pedido_id INTEGER,
        data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        valor_total DECIMAL(10,2),
        quantidade_titulos INTEGER,
        status TEXT DEFAULT 'pendente',
        data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Tabelas PostgreSQL criadas com sucesso!');
  } catch (err) {
    console.error('❌ Erro ao criar tabelas:', err);
  } finally {
    client.release();
  }
}

function calcularPrevisaoRecebimento(vencimento) {
  const dataVenc = new Date(vencimento);
  dataVenc.setDate(dataVenc.getDate() + 5);
  return dataVenc.toISOString().split('T')[0];
}

// Função para extrair dados do PDF da NF-e
async function extrairDadosPDF(pdfBuffer) {
  try {
    const data = await pdfParse(pdfBuffer);
    const text = data.text;
    
    console.log('=== INÍCIO EXTRAÇÃO PDF ===');
    console.log('Tamanho do texto:', text.length);
    console.log('Primeiros 500 caracteres:', text.substring(0, 500));
    console.log('===========================');

    // Extrair número da nota - múltiplos padrões
    let numeroNota = 'SEM_NUMERO';
    
    // Padrão 1: "NF-e" ou "NOTA FISCAL" seguido de número
    let numeroNotaMatch = text.match(/(?:NF-e|NOTA\s*FISCAL|N\.?\s*F\.?)[:\s]*N[ºª°]?\.?\s*(\d{6,})/i);
    if (numeroNotaMatch) numeroNota = numeroNotaMatch[1];
    
    // Padrão 2: Apenas "Nº" seguido de número
    if (numeroNota === 'SEM_NUMERO') {
      numeroNotaMatch = text.match(/N[ºª°]\.?\s*(\d{6,})/i);
      if (numeroNotaMatch) numeroNota = numeroNotaMatch[1];
    }
    
    // Padrão 3: Procurar número de 6+ dígitos após palavras-chave
    if (numeroNota === 'SEM_NUMERO') {
      numeroNotaMatch = text.match(/(?:NÚMERO|NUMERO|NUM)[:\s]*(\d{6,})/i);
      if (numeroNotaMatch) numeroNota = numeroNotaMatch[1];
    }
    
    console.log('Número da nota encontrado:', numeroNota);

    // Série
    const serieMatch = text.match(/(?:S[ÉE]RIE|SERIE)[:\s]*(\d+)/i);
    const serie = serieMatch ? serieMatch[1] : '1';
    console.log('Série encontrada:', serie);
    
    // Data de emissão
    const dataEmissaoMatch = text.match(/(?:EMISS[ÃA]O|DATA\s*(?:DE\s*)?EMISS[ÃA]O)[:\s]*(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i);
    const dataEmissao = dataEmissaoMatch ? dataEmissaoMatch[1].split(/[\/\-]/).reverse().join('-') : new Date().toISOString().split('T')[0];
    console.log('Data emissão:', dataEmissao);
    
    // Chave de acesso - 44 dígitos
    const chaveAcessoMatch = text.match(/(\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4})/);
    const chaveAcesso = chaveAcessoMatch ? chaveAcessoMatch[1].replace(/\s/g, '') : null;
    console.log('Chave de acesso:', chaveAcesso ? 'Encontrada' : 'Não encontrada');
    
    // Emitente - múltiplos padrões
    let emitenteNome = 'NÃO IDENTIFICADO';
    
    // Padrão 1: "RAZÃO SOCIAL" ou "NOME"
    let emitenteMatch = text.match(/(?:RAZ[ÃA]O\s*SOCIAL|NOME\s*(?:EMPRESARIAL)?)[:\s]*([^\n]{5,100})/i);
    if (emitenteMatch) {
      emitenteNome = emitenteMatch[1].trim();
    } else {
      // Padrão 2: "EMITENTE"
      emitenteMatch = text.match(/EMITENTE[:\s]*([^\n]{5,100})/i);
      if (emitenteMatch) emitenteNome = emitenteMatch[1].trim();
    }
    
    // Limpar nome do emitente (remover espaços extras, tabs, etc)
    emitenteNome = emitenteNome.replace(/\s+/g, ' ').trim();
    console.log('Emitente encontrado:', emitenteNome);
    
    // CNPJ do Emitente
    const emitenteCnpjMatch = text.match(/(?:CNPJ|CPF)[:\s]*(\d{2}\.?\d{3}\.?\d{3}[\/\\]?\d{4}[\-]?\d{2})/i);
    const emitenteCnpj = emitenteCnpjMatch ? emitenteCnpjMatch[1].replace(/[^\d]/g, '') : '';
    console.log('CNPJ Emitente:', emitenteCnpj || 'Não encontrado');
    
    // Destinatário/Cliente - múltiplos padrões
    let destinatarioNome = 'NÃO IDENTIFICADO';
    
    // Padrão 1: "DESTINATÁRIO" ou "REMETENTE"
    let destinatarioMatch = text.match(/(?:DESTINAT[ÁA]RIO[\/\\]?REMETENTE|DESTINAT[ÁA]RIO)[:\s]*([^\n]{5,100})/i);
    if (destinatarioMatch) {
      destinatarioNome = destinatarioMatch[1].trim();
    } else {
      // Padrão 2: "CLIENTE" ou "TOMADOR"
      destinatarioMatch = text.match(/(?:CLIENTE|TOMADOR)[:\s]*([^\n]{5,100})/i);
      if (destinatarioMatch) destinatarioNome = destinatarioMatch[1].trim();
    }
    
    // Limpar nome do destinatário
    destinatarioNome = destinatarioNome.replace(/\s+/g, ' ').trim();
    console.log('Destinatário encontrado:', destinatarioNome);
    
    // Segundo CNPJ (geralmente do destinatário)
    const allCnpjMatches = text.match(/(?:CNPJ|CPF)[:\s]*(\d{2}\.?\d{3}\.?\d{3}[\/\\]?\d{4}[\-]?\d{2})/gi);
    let destCnpj = '';
    if (allCnpjMatches && allCnpjMatches.length > 1) {
      const match = allCnpjMatches[1].match(/(\d{2}\.?\d{3}\.?\d{3}[\/\\]?\d{4}[\-]?\d{2})/);
      if (match) destCnpj = match[1].replace(/[^\d]/g, '');
    }
    console.log('CNPJ Destinatário:', destCnpj || 'Não encontrado');
    
    // Valor total (procurar por padrões como "VALOR TOTAL" ou "TOTAL DA NOTA")
    const valorTotalMatch = text.match(/(?:VALOR\s*TOTAL|TOTAL\s*(?:DA\s*)?(?:NOTA|NF)|VL\.?\s*TOTAL)[:\s]*R?\$?\s*([\d.,]+)/i);
    const valorTotal = valorTotalMatch ? parseFloat(valorTotalMatch[1].replace(/\./g, '').replace(',', '.')) : 0;
    console.log('Valor total:', valorTotal);
    
    // Duplicatas - múltiplos padrões
    const duplicatas = [];
    
    // Padrão 1: "001 15/01/2024 R$ 1.000,00"
    const dupRegex1 = /(\d{3}|\d{2}[\/\\]\d{3})\s+(\d{2}[\/\\]\d{2}[\/\\]\d{4})\s+R?\$?\s*([\d.,]+)/gi;
    let dupMatch;
    
    while ((dupMatch = dupRegex1.exec(text)) !== null) {
      const numero = dupMatch[1].replace(/[\/\\]/g, '');
      const vencimentoStr = dupMatch[2];
      const valor = parseFloat(dupMatch[3].replace(/\./g, '').replace(',', '.'));
      
      // Converter data DD/MM/YYYY para YYYY-MM-DD
      const dateParts = vencimentoStr.split(/[\/\\]/);
      const vencimento = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
      
      duplicatas.push({ numero, vencimento, valor });
    }
    
    // Padrão 2: "DUPLICATA 001 ... 15/01/2024 ... 1.000,00"
    if (duplicatas.length === 0) {
      const dupRegex2 = /(?:DUPLICATA|PARC(?:ELA)?)[:\s]*(\d+)[^\d]+([\d\/\\]+)[^\d]+([\d.,]+)/gi;
      while ((dupMatch = dupRegex2.exec(text)) !== null) {
        const numero = dupMatch[1].padStart(3, '0');
        const vencimentoStr = dupMatch[2];
        const valor = parseFloat(dupMatch[3].replace(/\./g, '').replace(',', '.'));
        
        if (vencimentoStr.includes('/') || vencimentoStr.includes('\\')) {
          const dateParts = vencimentoStr.split(/[\/\\]/);
          if (dateParts.length === 3) {
            const vencimento = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
            duplicatas.push({ numero, vencimento, valor });
          }
        }
      }
    }

    const resultado = {
      numeroNota: numeroNota,
      serie: serie,
      dataEmissao: dataEmissao,
      chaveAcesso: chaveAcesso,
      emitenteNome: emitenteNome,
      emitenteCnpj: emitenteCnpj,
      destinatarioNome: destinatarioNome,
      destinatarioCnpj: destCnpj,
      valorTotal: valorTotal,
      duplicatas: duplicatas
    };

    console.log('=== RESULTADO FINAL ===');
    console.log(JSON.stringify(resultado, null, 2));
    console.log('=======================');

    // Se não encontrou duplicatas e tem valor total, criar duplicata padrão
    if (resultado.duplicatas.length === 0 && resultado.valorTotal > 0) {
      const vencimento30dias = new Date();
      vencimento30dias.setDate(vencimento30dias.getDate() + 30);
      resultado.duplicatas.push({
        numero: '001',
        vencimento: vencimento30dias.toISOString().split('T')[0],
        valor: resultado.valorTotal
      });
      console.log('Criada duplicata padrão (venc. 30 dias)');
    }

    return resultado;
  } catch (error) {
    console.error('Erro ao processar PDF:', error);
    throw new Error(`Erro ao processar PDF: ${error.message}. Certifique-se de que é um PDF válido de NF-e.`);
  }
}

// Função para extrair dados do XML da NF-e
async function extrairDadosXML(xmlContent) {
  const parser = new xml2js.Parser({ explicitArray: false });
  
  try {
    const result = await parser.parseStringPromise(xmlContent);
    
    // Navegar pela estrutura do XML da NF-e
    const nfe = result.nfeProc?.NFe?.infNFe || result.NFe?.infNFe;
    
    if (!nfe) {
      throw new Error('Estrutura XML inválida');
    }

    const ide = nfe.ide;
    const emit = nfe.emit;
    const dest = nfe.dest;
    const total = nfe.total?.ICMSTot;
    const cobr = nfe.cobr;

    // Extrair duplicatas
    let duplicatas = [];
    if (cobr?.dup) {
      const dups = Array.isArray(cobr.dup) ? cobr.dup : [cobr.dup];
      duplicatas = dups.map(dup => ({
        numero: dup.nDup,
        valor: parseFloat(dup.vDup),
        vencimento: dup.dVenc
      }));
    }

    const valorTotal = parseFloat(total?.vNF || 0);

    // Se não houver duplicatas e houver valor total, criar duplicata padrão
    if (duplicatas.length === 0 && valorTotal > 0) {
      const vencimento30dias = new Date();
      vencimento30dias.setDate(vencimento30dias.getDate() + 30);
      duplicatas.push({

// Função para extrair dados do XML da NF-e
async function extrairDadosXML(xmlContent) {
  const parser = new xml2js.Parser({ explicitArray: false });
  
  try {
    const result = await parser.parseStringPromise(xmlContent);
    
    // Navegar pela estrutura do XML da NF-e
    const nfe = result.nfeProc?.NFe?.infNFe || result.NFe?.infNFe;
    
    if (!nfe) {
      throw new Error('Estrutura XML inválida');
    }

    const ide = nfe.ide;
    const emit = nfe.emit;
    const dest = nfe.dest;
    const total = nfe.total?.ICMSTot;
    const cobr = nfe.cobr;

    // Extrair duplicatas
    let duplicatas = [];
    if (cobr?.dup) {
      const dups = Array.isArray(cobr.dup) ? cobr.dup : [cobr.dup];
      duplicatas = dups.map(dup => ({
        numero: dup.nDup,
        valor: parseFloat(dup.vDup),
        vencimento: dup.dVenc
      }));
    }

    const valorTotal = parseFloat(total?.vNF || 0);

    // Se não houver duplicatas e houver valor total, criar duplicata padrão
    if (duplicatas.length === 0 && valorTotal > 0) {
      const vencimento30dias = new Date();
      vencimento30dias.setDate(vencimento30dias.getDate() + 30);
      duplicatas.push({
        numero: '001',
        valor: valorTotal,
        vencimento: vencimento30dias.toISOString().split('T')[0]
      });
      console.log('XML sem duplicatas: criada duplicata padrão com valor total da nota');
    }

    return {
      numeroNota: ide.nNF,
      serie: ide.serie,
      dataEmissao: ide.dhEmi || ide.dEmi,
      chaveAcesso: nfe.$.Id?.replace('NFe', ''),
      emitenteNome: emit.xNome,
      emitenteCnpj: emit.CNPJ,
      destinatarioNome: dest?.xNome || '',
      destinatarioCnpj: dest?.CNPJ || '',
      valorTotal: valorTotal,
      duplicatas: duplicatas
    };
  } catch (error) {
    console.error('Erro ao processar XML:', error);
    throw new Error('Erro ao processar XML: ' + error.message);
  }
}


// ==========================================
// ROTAS API - PostgreSQL
// ==========================================

// Preview PDF
app.post('/api/preview-pdf', upload.single('pdfFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    
    const pdfBuffer = fs.readFileSync(req.file.path);
    const dados = await extrairDadosPDF(pdfBuffer);
    fs.unlinkSync(req.file.path);
    
    res.json({ success: true, dados });
  } catch (error) {
    console.error('Erro preview PDF:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// Importar PDF
app.post('/api/importar-pdf', upload.single('pdfFile'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    
    const percentualComissao = parseFloat(req.body.percentualComissao);
    if (!percentualComissao || percentualComissao <= 0 || percentualComissao > 100) {
      return res.status(400).json({ error: 'Percentual inválido' });
    }

    const pdfBuffer = fs.readFileSync(req.file.path);
    const dados = await extrairDadosPDF(pdfBuffer);

    // Verifica duplicata
    if (dados.chaveAcesso) {
      const check = await client.query('SELECT id FROM notas_fiscais WHERE chave_acesso = $1', [dados.chaveAcesso]);
      if (check.rows.length > 0) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Nota já importada' });
      }
    }

    // Inserir nota
    const notaResult = await client.query(
      `INSERT INTO notas_fiscais (numero_nota, serie, data_emissao, chave_acesso, emitente_nome, emitente_cnpj, destinatario_nome, destinatario_cnpj, valor_total, xml_completo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [dados.numeroNota, dados.serie, dados.dataEmissao, dados.chaveAcesso, dados.emitenteNome, dados.emitenteCnpj, dados.destinatarioNome, dados.destinatarioCnpj, dados.valorTotal, 'PDF_IMPORT']
    );
    
    const notaFiscalId = notaResult.rows[0].id;
    const titulos = [];

    // Inserir duplicatas e títulos
    for (const dup of dados.duplicatas) {
      const previsaoRecebimento = calcularPrevisaoRecebimento(dup.vencimento);
      
      const dupResult = await client.query(
        `INSERT INTO duplicatas (nota_fiscal_id, numero_duplicata, valor, vencimento, previsao_recebimento)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [notaFiscalId, dup.numero, dup.valor, dup.vencimento, previsaoRecebimento]
      );
      
      const duplicataId = dupResult.rows[0].id;
      const valorComissao = (dup.valor * percentualComissao) / 100;

      const tituloResult = await client.query(
        `INSERT INTO titulos_comissao (duplicata_id, nota_fiscal_id, percentual_comissao, valor_comissao)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [duplicataId, notaFiscalId, percentualComissao, valorComissao]
      );

      titulos.push({
        id: tituloResult.rows[0].id,
        numero_duplicata: dup.numero,
        valor_duplicata: dup.valor,
        vencimento: dup.vencimento,
        percentual_comissao: percentualComissao,
        valor_comissao: valorComissao
      });
    }

    fs.unlinkSync(req.file.path);
    res.json({
      success: true,
      message: 'PDF importado com sucesso',
      quantidadeTitulos: titulos.length,
      titulos
    });

  } catch (error) {
    console.error('Erro ao importar PDF:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Importar XML
app.post('/api/importar-xml', upload.single('xmlFile'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    
    const percentualComissao = parseFloat(req.body.percentualComissao);
    if (!percentualComissao || percentualComissao <= 0 || percentualComissao > 100) {
      return res.status(400).json({ error: 'Percentual inválido' });
    }

    const xmlContent = fs.readFileSync(req.file.path, 'utf-8');
    const dados = await extrairDadosXML(xmlContent);

    // Verifica duplicata
    const check = await client.query('SELECT id FROM notas_fiscais WHERE chave_acesso = $1', [dados.chaveAcesso]);
    if (check.rows.length > 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Nota já importada' });
    }

    // Inserir nota
    const notaResult = await client.query(
      `INSERT INTO notas_fiscais (numero_nota, serie, data_emissao, chave_acesso, emitente_nome, emitente_cnpj, destinatario_nome, destinatario_cnpj, valor_total, xml_completo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [dados.numeroNota, dados.serie, dados.dataEmissao, dados.chaveAcesso, dados.emitenteNome, dados.emitenteCnpj, dados.destinatarioNome, dados.destinatarioCnpj, dados.valorTotal, xmlContent]
    );
    
    const notaFiscalId = notaResult.rows[0].id;
    const titulos = [];

    // Inserir duplicatas e títulos
    for (const dup of dados.duplicatas) {
      const previsaoRecebimento = calcularPrevisaoRecebimento(dup.vencimento);
      
      const dupResult = await client.query(
        `INSERT INTO duplicatas (nota_fiscal_id, numero_duplicata, valor, vencimento, previsao_recebimento)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [notaFiscalId, dup.numero, dup.valor, dup.vencimento, previsaoRecebimento]
      );
      
      const duplicataId = dupResult.rows[0].id;
      const valorComissao = (dup.valor * percentualComissao) / 100;

      const tituloResult = await client.query(
        `INSERT INTO titulos_comissao (duplicata_id, nota_fiscal_id, percentual_comissao, valor_comissao)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [duplicataId, notaFiscalId, percentualComissao, valorComissao]
      );

      titulos.push({
        id: tituloResult.rows[0].id,
        numero_duplicata: dup.numero,
        valor_duplicata: dup.valor,
        vencimento: dup.vencimento,
        percentual_comissao: percentualComissao,
        valor_comissao: valorComissao
      });
    }

    fs.unlinkSync(req.file.path);
    res.json({
      success: true,
      message: 'XML importado com sucesso',
      quantidadeTitulos: titulos.length,
      titulos
    });

  } catch (error) {
    console.error('Erro ao importar XML:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Dashboard
app.get('/api/dashboard', async (req, res) => {
  const client = await pool.connect();
  try {
    const notasResult = await client.query('SELECT COUNT(*) as total, COALESCE(SUM(valor_total), 0) as valor FROM notas_fiscais');
    const titulosResult = await client.query('SELECT COUNT(*) as total, COALESCE(SUM(valor_comissao), 0) as valor, COUNT(CASE WHEN status = $1 THEN 1 END) as pendentes FROM titulos_comissao', ['pendente']);
    const pedidosResult = await client.query('SELECT COUNT(*) as total, COALESCE(SUM(valor_total), 0) as valor FROM pedidos');

    res.json({
      notasFiscais: { total: parseInt(notasResult.rows[0].total), valor: parseFloat(notasResult.rows[0].valor) },
      titulosComissao: { total: parseInt(titulosResult.rows[0].total), valor: parseFloat(titulosResult.rows[0].valor), pendentes: parseInt(titulosResult.rows[0].pendentes) },
      pedidos: { total: parseInt(pedidosResult.rows[0].total), valor: parseFloat(pedidosResult.rows[0].valor) }
    });
  } catch (error) {
    console.error('Erro dashboard:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Listar títulos
app.get('/api/titulos-comissao', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT tc.id, tc.valor_comissao, tc.percentual_comissao, tc.status, tc.status_pagamento, tc.pedido_id, tc.data_criacao,
             nf.numero_nota, nf.emitente_nome, nf.destinatario_nome as cliente_nome,
             d.numero_duplicata, d.valor as valor_duplicata, d.vencimento, d.previsao_recebimento
      FROM titulos_comissao tc
      JOIN notas_fiscais nf ON tc.nota_fiscal_id = nf.id
      JOIN duplicatas d ON tc.duplicata_id = d.id
      ORDER BY tc.data_criacao DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Erro listar títulos:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Buscar título por ID
app.get('/api/titulos-comissao/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT tc.*, nf.numero_nota, nf.emitente_nome, nf.destinatario_nome as cliente_nome,
             d.numero_duplicata, d.valor as valor_duplicata, d.vencimento, d.previsao_recebimento
      FROM titulos_comissao tc
      JOIN notas_fiscais nf ON tc.nota_fiscal_id = nf.id
      JOIN duplicatas d ON tc.duplicata_id = d.id
      WHERE tc.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Título não encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro buscar título:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Atualizar título
app.put('/api/titulos-comissao/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { valorComissao, statusPagamento } = req.body;
    const tituloId = req.params.id;

    // Verificar se título existe e se tem pedido
    const check = await client.query('SELECT pedido_id FROM titulos_comissao WHERE id = $1', [tituloId]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Título não encontrado' });
    }

    if (check.rows[0].pedido_id && valorComissao !== undefined) {
      return res.status(400).json({ error: 'Não é possível editar valor de título em pedido' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (valorComissao !== undefined) {
      updates.push(`valor_comissao = $${paramCount++}`);
      values.push(valorComissao);
    }

    if (statusPagamento) {
      updates.push(`status_pagamento = $${paramCount++}`);
      values.push(statusPagamento);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    values.push(tituloId);
    await client.query(`UPDATE titulos_comissao SET ${updates.join(', ')} WHERE id = $${paramCount}`, values);

    res.json({ success: true, message: 'Título atualizado' });
  } catch (error) {
    console.error('Erro atualizar título:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Criar pedido
app.post('/api/pedidos', async (req, res) => {
  const client = await pool.connect();
  try {
    const { titulosIds } = req.body;

    if (!Array.isArray(titulosIds) || titulosIds.length === 0) {
      return res.status(400).json({ error: 'IDs de títulos inválidos' });
    }

    await client.query('BEGIN');

    // Verificar títulos
    const placeholders = titulosIds.map((_, i) => `$${i + 1}`).join(',');
    const check = await client.query(`SELECT id, valor_comissao, status, pedido_id FROM titulos_comissao WHERE id IN (${placeholders})`, titulosIds);

    if (check.rows.length !== titulosIds.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Um ou mais títulos não encontrados' });
    }

    const tituloEmPedido = check.rows.find(t => t.pedido_id);
    if (tituloEmPedido) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Um ou mais títulos já estão em pedido' });
    }

    const valorTotal = check.rows.reduce((sum, t) => sum + parseFloat(t.valor_comissao), 0);

    // Criar pedido
    const pedidoResult = await client.query(
      'INSERT INTO pedidos (valor_total, quantidade_titulos) VALUES ($1, $2) RETURNING id',
      [valorTotal, titulosIds.length]
    );

    const pedidoId = pedidoResult.rows[0].id;

    // Atualizar títulos
    await client.query(`UPDATE titulos_comissao SET status = $1, pedido_id = $2 WHERE id IN (${placeholders})`, ['em_pedido', pedidoId, ...titulosIds]);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Pedido criado com sucesso',
      pedidoId,
      valorTotal,
      quantidadeTitulos: titulosIds.length
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro criar pedido:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Listar pedidos
app.get('/api/pedidos', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM pedidos ORDER BY data_criacao DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Erro listar pedidos:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Buscar pedido por ID
app.get('/api/pedidos/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const pedidoResult = await client.query('SELECT * FROM pedidos WHERE id = $1', [req.params.id]);
    if (pedidoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    const titulosResult = await client.query(`
      SELECT tc.*, nf.numero_nota, nf.emitente_nome, d.numero_duplicata, d.valor as valor_duplicata, d.vencimento
      FROM titulos_comissao tc
      JOIN notas_fiscais nf ON tc.nota_fiscal_id = nf.id
      JOIN duplicatas d ON tc.duplicata_id = d.id
      WHERE tc.pedido_id = $1
    `, [req.params.id]);

    res.json({
      pedido: pedidoResult.rows[0],
      titulos: titulosResult.rows
    });
  } catch (error) {
    console.error('Erro buscar pedido:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Listar notas fiscais
app.get('/api/notas-fiscais', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM notas_fiscais ORDER BY data_importacao DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Erro listar notas:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Deletar nota fiscal
app.delete('/api/notas-fiscais/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM notas_fiscais WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Nota fiscal excluída' });
  } catch (error) {
    console.error('Erro deletar nota:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

