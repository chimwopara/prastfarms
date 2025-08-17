// =======================================================================
// IMPORTANT: SET THE URL WHERE YOUR WEBSITE IS HOSTED
// Example: "https://username.github.io/prastfarms/"
// =======================================================================
const WEBSITE_BASE_URL = "https://your-website-url.com/"; 
// =======================================================================

const SHEET_NAME = "Sheet1";
const PASSWORD = PropertiesService.getScriptProperties().getProperty('ACCESS_PASSWORD');

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    let response;

    switch (data.action) {
      case "addRecord":
        // Password check for adding records
        if (data.password !== PASSWORD) throw new Error("Incorrect password.");
        response = addRecord(data.payload);
        break;
      case "getRecords":
        response = getRecords(data.payload);
        break;
      case "getRecordById":
        response = getRecordById(data.payload);
        break;
      case "renewRecord":
        response = renewRecord(data.payload);
        break;
      default:
        throw new Error("Invalid action specified.");
    }
    return ContentService.createTextOutput(JSON.stringify({ status: "success", data: response })).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

function addRecord(payload) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const newRowData = [
    payload.type, payload.firstName, payload.lastName,
    payload.investDate, payload.dueDate,
    payload.investSum, payload.dueSum,
    '', // RenewDate is blank for new records
    0   // TotalYears starts at 0
  ];
  sheet.appendRow(newRowData);
  
  // Return the newly created record so the front-end can update its list
  const newRecord = {
    Row: sheet.getLastRow(), Type: payload.type, FirstName: payload.firstName, LastName: payload.lastName,
    InvestDate: payload.investDate, DueDate: payload.dueDate, InvestSum: payload.investSum,
    DueSum: payload.dueSum, RenewDate: '', TotalYears: 0
  };
  return { message: "Record added successfully!", newRecord: newRecord };
}

function getRecords(payload) {
  if (payload.password !== PASSWORD) throw new Error("Incorrect password.");
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const header = data.shift();
  
  const records = data.map((row, index) => {
    let record = { Row: index + 2 }; // Add row number as a unique ID
    header.forEach((colName, i) => record[colName] = row[i]);
    return record;
  });
  return records;
}

function getRecordById(payload) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const rowData = sheet.getRange(parseInt(payload.recordId), 1, 1, sheet.getLastColumn()).getValues()[0];
    
    let record = { Row: parseInt(payload.recordId) };
    header.forEach((colName, i) => record[colName] = rowData[i]);
    return record;
}

function renewRecord(payload) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const row = parseInt(payload.recordId);

    // Find the correct columns by header name
    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const investDateCol = header.indexOf("InvestDate") + 1;
    const dueDateCol = header.indexOf("DueDate") + 1;
    const investSumCol = header.indexOf("InvestSum") + 1;
    const dueSumCol = header.indexOf("DueSum") + 1;
    const renewDateCol = header.indexOf("RenewDate") + 1;
    const totalYearsCol = header.indexOf("TotalYears") + 1;

    // Update the values in the sheet
    sheet.getRange(row, investDateCol).setValue(payload.investDate);
    sheet.getRange(row, dueDateCol).setValue(payload.dueDate);
    sheet.getRange(row, investSumCol).setValue(payload.investSum);
    sheet.getRange(row, dueSumCol).setValue(payload.dueSum);
    sheet.getRange(row, renewDateCol).setValue(new Date()); // Set renew date to today
    
    // Increment the TotalYears count
    const currentYears = sheet.getRange(row, totalYearsCol).getValue() || 0;
    sheet.getRange(row, totalYearsCol).setValue(currentYears + 1);

    return "Record renewed successfully!";
}


function checkDueDateAndSendEmail() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const header = data.shift();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dueDateColumnIndex = header.indexOf("DueDate");
  const nameColumnIndex = header.indexOf("FirstName");

  let dueTodayList = [];

  data.forEach((row, index) => {
    const dueDate = new Date(row[dueDateColumnIndex]);
    dueDate.setHours(0, 0, 0, 0);

    if (dueDate.getTime() === today.getTime()) {
      dueTodayList.push({
          name: row[nameColumnIndex],
          id: index + 2 // Row number is index + 2 (1 for header, 1 for 0-based index)
      });
    }
  });

  if (dueTodayList.length > 0) {
    const ownerEmail = Session.getActiveUser().getEmail();
    const secondEmail = "stellawopara77@gmail.com";
    const recipientEmails = `${ownerEmail},${secondEmail}`;
    const subject = "Prast Farms: Investment Due Date Reminder";
    
    let body = "Hello,\n\nThis is a reminder that the following investments are due today:\n\n";
    
    dueTodayList.forEach(item => {
        const renewalLink = `${WEBSITE_BASE_URL}renew.html?id=${item.id}`;
        body += `- ${item.name}: Click to Renew -> ${renewalLink}\n`;
    });

    body += "\n- Prast Farms Automated Tracker";
    MailApp.sendEmail(recipientEmails, subject, body);
  }
}
