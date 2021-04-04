process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://f1a087d566d2464eb02fd858bd00b30f@sentry.cozycloud.cc/135'

const {
  BaseKonnector,
  requestFactory,
  log,
  errors,
  cozyClient,
  updateOrCreate,
  saveFiles,
  saveBills
} = require('cozy-konnector-libs')
const moment = require('moment')
const doctypes = require('cozy-doctypes')
const {
  Document,
  BankAccount,
  BankTransaction,
  BalanceHistory,
  BankingReconciliator
} = doctypes

Document.registerClient(cozyClient)

// Banking reconciliator used to save the accounts
const reconciliator = new BankingReconciliator({ BankAccount, BankTransaction })

// Requests options
const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true,
  jar: true,
  // Use default user-agent
  userAgent: true
})

const VENDOR = 'Nalo'
const baseApiUrl = 'https://nalo.fr/api/v1'

module.exports = new BaseKonnector(start)

// Main function
async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  const userToken = await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Retrieve documents')
  await retrieveDocuments(userToken, fields)

  log('info', 'Retrieving details of bank accounts')
  const bankAccounts = await getBankAccounts(userToken)

  log('info', 'Saving accounts and balances')
  // Save accounts, without any operations as there are none for life insurance
  const { accounts: savedAccounts } = await reconciliator.save(bankAccounts, [])
  await saveBalances(savedAccounts)

  log('info', 'All done!')
}

// Authenticate to Nalo
function authenticate(username, password) {
  return request(`${baseApiUrl}/login`, {
    method: 'POST',
    form: {
      email: username,
      password: password,
      userToken: false
    }
  })
    .then($ => {
      if ($.detail.token) {
        return $.detail.token
      } else {
        log('error', 'Failed to retrieve user token')
        throw new Error(errors.LOGIN_FAILED)
      }
    })
    .catch($ => {
      log('error', $.error.detail)
      throw new Error(errors.LOGIN_FAILED)
    })
}

// List and retrieve all available documents
async function retrieveDocuments(userToken, fields) {
  // Retrieve list of signed documents
  const contractDocs = await request(
    `${baseApiUrl}/profiles/me/signed-documents/`,
    {
      headers: {
        Authorization: 'Token ' + userToken
      }
    }
  )
    .then($ => {
      return $.detail
    })
    .catch($ => {
      log('error', $.error)
      throw new Error(errors.VENDOR_DOWN)
    })

  // Retrieve each signed document
  let docs = []
  for (let doc of contractDocs) {
    const file = await request(
      `${baseApiUrl}/profiles/me/signed-document-content/${doc.id}`,
      {
        headers: {
          Authorization: 'Token ' + userToken
        },
        cheerio: false,
        json: true
      }
    )
      .then($ => {
        return $.detail
      })
      .catch($ => {
        log('error', $.error)
        throw new Error(errors.VENDOR_DOWN)
      })

    docs.push({
      filename: file.filename,
      filestream: Buffer.from(file.data, 'base64'),
      vendor: VENDOR,
      metadata: {
        importDate: new Date(),
        version: 1
      }
    })
  }

  // Save signed documents
  await saveFiles(docs, fields, {
    contentType: 'application/pdf'
  })

  // Retrieve list of transactional documents
  const transactionalDocs = await request(
    `${baseApiUrl}/account/transactional-pdfs`,
    {
      headers: {
        Authorization: 'Token ' + userToken
      }
    }
  )
    .then($ => {
      return $.detail
    })
    .catch($ => {
      log('error', $.error)
      throw new Error(errors.VENDOR_DOWN)
    })

  // Retrieve each transactional document
  docs = []
  for (let doc of transactionalDocs) {
    const file = await request(
      `${baseApiUrl}/contract/get-document/${doc.contract_id}/${doc.id_operation}`,
      {
        headers: {
          Authorization: 'Token ' + userToken
        },
        cheerio: false,
        json: true
      }
    )
      .then($ => {
        return $.detail
      })
      .catch($ => {
        log('error', $.error)
        throw new Error(errors.VENDOR_DOWN)
      })

    docs.push({
      filename: file.filename,
      filestream: Buffer.from(file.data, 'base64'),
      vendor: VENDOR,
      metadata: {
        importDate: new Date(),
        version: 1
      }
    })
  }

  // Save transactional documents
  await saveBills(docs, fields, {
    // This is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['generali vie'],
    contentType: 'application/pdf',
    processPdf: parseAmountAndDate
  })
}

// Parse PDF in order to retrieve invoice amount and date
function parseAmountAndDate(entry, text) {
  const lines = text.split('\n')

  // Check if PDF is an invoice for a transfer
  const transferLines = lines
    .map(line => line.match(/^Versement complémentaire$/))
    .filter(Boolean)
  if (transferLines.length === 0) {
    log('debug', 'Not a transfer invoice')
    entry.__ignore = true
    return entry
  }

  // Find date in PDF
  const dateLines = lines
    .map(line => line.match(/^Paris,\s+le\s+(.*)$/))
    .filter(Boolean)
  if (dateLines.length === 0 || dateLines.length !== 1) {
    log('warn', `No date or too many dates found (length=${dateLines.length}`)
  } else {
    entry.date = moment(dateLines[0][1], 'DD MMMM YYYY', 'fr').toDate()
  }

  // Find transfer amount in PDF
  const amountLines = text.match(
    /\s+Montant\n\s+brut\n\s+versé:\n\s+(.*)\n\s+Euros/
  )
  if (!amountLines || amountLines.length === 0 || amountLines.length !== 2) {
    log(
      'warn',
      `No amount or too many amounts found (length=${
        dateLines ? dateLines.length : 'null'
      }`
    )
  } else {
    entry.amount = normalizePrice(amountLines[1])
  }

  // TODO Find a way to set the correct filename based on the vendor, date, and
  // amount. Setting it here will not be useful, as the file has already been
  // saved by saveFiles at this point.

  return entry
}

// Create Cozy bank accounts, see documentation on https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankaccounts
function getBankAccounts(userToken) {
  return request(`${baseApiUrl}/projects/mine/without-details`, {
    headers: {
      Authorization: 'Token ' + userToken
    }
  })
    .then($ => {
      if ($.detail) {
        let accounts = []
        for (let x of $.detail) {
          accounts.push({
            label: x.name,
            institutionLabel: 'Nalo',
            balance: parseFloat(x.current_value.toFixed(2)),
            type: 'LifeInsurance',
            number: x.id.toString(),
            vendorId: x.id.toString(),
            currency: 'EUR'
          })
        }
        return accounts
      } else {
        log('error', 'Failed to retrieve project details')
        throw new Error(errors.LOGIN_FAILED)
      }
    })
    .catch($ => {
      log('error', $.error)
      throw new Error(errors.VENDOR_DOWN)
    })
}

// Create Cozy balance histories, see documentation on https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankbalancehistories
async function saveBalances(accounts) {
  const now = moment()
  const balances = await Promise.all(
    accounts.map(async account => {
      const history = await BalanceHistory.getByYearAndAccount(
        now.year(),
        account._id
      )
      history.balances[now.format('YYYY-MM-DD')] = account.balance

      return history
    })
  )

  return updateOrCreate(balances, 'io.cozy.bank.balancehistories', ['_id'])
}

// Convert a price string to a float
function normalizePrice(price) {
  // Replace ',' by '.' and remove extra white spaces for parseFloat
  return parseFloat(
    price
      .replace(',', '.')
      .replace(/\s/g, '')
      .trim()
  )
}
