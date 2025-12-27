// =======================================================================
// IMPORTANT: SET THE URL WHERE YOUR WEBSITE IS HOSTED
// Example: "https://username.github.io/prastfarms/"
// =======================================================================
const WEBSITE_BASE_URL = "https://github.com/chimwopara/prastfarms/"; 
// =======================================================================

const SHEET_NAME = "Sheet1";
const PASSWORD = PropertiesService.getScriptProperties().getProperty('ACCESS_PASSWORD');

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    console.log('Received request:', data.action); // Debug log
    let response;

    switch (data.action) {
      case "addRecord":
        if (data.password !== PASSWORD) throw new Error("Incorrect password.");
        response = addRecord(data.payload);
        break;
      case "getRecords":
        console.log('Processing getRecords request'); // Debug log
        response = getRecords(data.payload);
        console.log('getRecords response:', response); // Debug log
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
    console.log('Sending success response for', data.action); // Debug log
    return ContentService.createTextOutput(JSON.stringify({ status: "success", data: response })).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    console.error('Error in doPost:', error); // Debug log
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: error.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

function addRecord(payload) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const newRowData = [
    payload.type,        // Column A: type
    payload.firstName,   // Column B: firstname  
    payload.lastName,    // Column C: lastname
    payload.investDate,  // Column D: investdate
    payload.dueDate,     // Column E: duedate
    payload.investSum,   // Column F: investsum
    payload.dueSum,      // Column G: duesum
    '',                  // Column H: renewdate (empty initially)
    0                    // Column I: totalyears (0 initially)
  ];
  sheet.appendRow(newRowData);
  
  const newRecord = {
    Row: sheet.getLastRow(), 
    Type: payload.type, 
    FirstName: payload.firstName, 
    LastName: payload.lastName,
    InvestDate: payload.investDate, 
    DueDate: payload.dueDate, 
    InvestSum: payload.investSum,
    DueSum: payload.dueSum, 
    RenewDate: '', 
    TotalYears: 0
  };
  return { message: "Record added successfully!", newRecord: newRecord };
}

// REPLACE THE getRecords FUNCTION WITH THIS FIXED VERSION
function getRecords(payload) {
  if (payload.password !== PASSWORD) throw new Error("Incorrect password.");
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const header = data.shift();
  
  const records = data.map((row, index) => {
    let record = { Row: index + 2 };
    header.forEach((colName, i) => {
      let value = row[i];
      
      // Convert dates to YYYY-MM-DD format
      if (value instanceof Date) {
        value = Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
      }
      
      // Map to expected frontend property names
      record[colName] = value;
    });
    return record;
  });
  return records;
}

function getRecordById(payload) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const rowData = sheet.getRange(parseInt(payload.recordId), 1, 1, sheet.getLastColumn()).getValues()[0];
    
    const record = {
      Row: parseInt(payload.recordId),
      Type: rowData[0] || '',
      FirstName: rowData[1] || '',
      LastName: rowData[2] || '',
      InvestDate: rowData[3] || '',
      DueDate: rowData[4] || '',
      InvestSum: rowData[5] || '',
      DueSum: rowData[6] || '',
      RenewDate: rowData[7] || '',
      TotalYears: rowData[8] || 0
    };
    
    return record;
}

function renewRecord(payload) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const row = parseInt(payload.recordId);

    // Update the record with new values
    sheet.getRange(row, 4).setValue(payload.investDate);  // Column D: investdate
    sheet.getRange(row, 5).setValue(payload.dueDate);     // Column E: duedate
    sheet.getRange(row, 6).setValue(payload.investSum);   // Column F: investsum
    sheet.getRange(row, 7).setValue(payload.dueSum);      // Column G: duesum
    sheet.getRange(row, 8).setValue(new Date());          // Column H: renewdate
    
    const currentYears = sheet.getRange(row, 9).getValue() || 0;
    sheet.getRange(row, 9).setValue(currentYears + 1);    // Column I: totalyears

    return "Record renewed successfully!";
}

function checkDueDateAndSendEmail() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const header = data.shift();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dueDateColumnIndex = 4; // Column E (0-indexed)
  const firstNameColumnIndex = 1; // Column B (0-indexed)

  let dueTodayList = [];

  data.forEach((row, index) => {
    if (!row[dueDateColumnIndex]) return; // Skip empty rows
    const dueDate = new Date(row[dueDateColumnIndex]);
    dueDate.setHours(0, 0, 0, 0);

    if (dueDate.getTime() === today.getTime()) {
      dueTodayList.push({
          name: row[firstNameColumnIndex],
          id: index + 2
      });
    }
  });

  if (dueTodayList.length > 0) {
    const ownerEmail = Session.getActiveUser().getEmail();
    const secondEmail = "stellawopara77@gmail.com";
    const recipientEmails = `${ownerEmail},${secondEmail}`;
    const subject = "Prast Tracker: Investment Due Date Reminder";
    
    let body = "Hello,\n\nThis is a reminder that the following investments are due today:\n\n";
    
    dueTodayList.forEach(item => {
        const renewalLink = `${WEBSITE_BASE_URL}renew.html?id=${item.id}`;
        body += `- ${item.name}: Click to Renew -> ${renewalLink}\n`;
    });

    body += "\n- Prast Tracker Automated System";
    MailApp.sendEmail(recipientEmails, subject, body);
  }
}