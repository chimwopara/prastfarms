// Set the name of the sheet where data is stored.
const SHEET_NAME = "Sheet1";
// Set the password required to access the data.
const PASSWORD = "$stella";

/**
 * Main function that handles GET requests to the web app.
 * This is required by Google Apps Script for web apps.
 */
function doGet(e) {
  return HtmlService.createHtmlOutput("Request received");
}

/**
 * Main function that handles POST requests from the website.
 * It routes the request to either add or get data based on the 'action' parameter.
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    let response;

    // Route action to the appropriate function
    if (data.action === "addRecord") {
      response = addRecord(data.payload);
    } else if (data.action === "getRecords") {
      response = getRecords(data.payload);
    } else {
      throw new Error("Invalid action specified.");
    }

    // Return a success response with the result
    return ContentService.createTextOutput(JSON.stringify({ status: "success", data: response }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    // Return an error response if something goes wrong
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Adds a new record to the Google Sheet.
 * The order of properties in the 'payload' object MUST match the column order in the sheet.
 */
function addRecord(payload) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  // The order here is critical: Type, FirstName, LastName, etc.
  const newRow = [
    payload.type,
    payload.firstName,
    payload.lastName,
    payload.investDate,
    payload.dueDate,
    payload.investSum,
    payload.dueSum,
    payload.renewDate,
    payload.totalYears
  ];
  sheet.appendRow(newRow);
  return "Record added successfully!";
}

/**
 * Retrieves records from the Google Sheet.
 * Requires a correct password.
 */
function getRecords(payload) {
  // Password check
  if (payload.password !== PASSWORD) {
    throw new Error("Incorrect password.");
  }
  
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  // Get all data from the sheet, excluding the header row.
  const data = sheet.getDataRange().getValues();
  const header = data.shift(); // Remove header row
  
  // Convert the 2D array of data into an array of objects for easier use in JavaScript.
  const records = data.map(row => {
    let record = {};
    header.forEach((colName, index) => {
      record[colName] = row[index];
    });
    return record;
  });
  
  return records;
}

/**
 * A trigger function that runs automatically every day to check for due dates.
 * It sends an email reminder if any investment is due on the current day.
 */
function checkDueDateAndSendEmail() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const header = data.shift();
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Normalize today's date to midnight

  const dueDateColumnIndex = header.indexOf("DueDate");
  const nameColumnIndex = header.indexOf("FirstName");

  let dueTodayList = [];

  // Loop through all rows to find due dates
  data.forEach(row => {
    const dueDate = new Date(row[dueDateColumnIndex]);
    dueDate.setHours(0, 0, 0, 0); // Normalize due date to midnight

    if (dueDate.getTime() === today.getTime()) {
      dueTodayList.push(row[nameColumnIndex]);
    }
  });

  // If there are any payments due today, send an email.
  if (dueTodayList.length > 0) {
    const recipientEmail = Session.getActiveUser().getEmail(); // Gets the email of the sheet owner
    const subject = "Prast Farms: Investment Due Date Reminder";
    const body = "Hello,\n\nThis is a reminder that the following investments are due today:\n\n- " + dueTodayList.join("\n- ") + "\n\nPlease check your records.\n\n- Prast Farms Automated Tracker";
    MailApp.sendEmail(recipientEmail, subject, body);
  }
}
