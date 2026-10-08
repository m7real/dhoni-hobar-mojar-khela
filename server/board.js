'use strict';

// Standard 40-tile Monopoly structure, localized with Bangladeshi places.
const GROUPS = {
  BROWN: 'brown',
  LIGHT_BLUE: 'lightblue',
  PINK: 'pink',
  ORANGE: 'orange',
  RED: 'red',
  YELLOW: 'yellow',
  GREEN: 'green',
  DARK_BLUE: 'darkblue',
  RAIL: 'rail',
  UTILITY: 'utility'
};

const TILES = [
  { id: 0, type: 'go', name: 'START', bn: 'শুরু' },

  { id: 1, type: 'property', group: GROUPS.BROWN, name: 'Kali Bazar', bn: 'কালীবাজার', price: 60, rent: [2, 10, 30, 90, 160, 250], houseCost: 50 },
  { id: 2, type: 'chest', name: 'Bhagya', bn: 'ভাগ্য' },
  { id: 3, type: 'property', group: GROUPS.BROWN, name: 'Patuakhali Ghat', bn: 'পাটুয়াঘাটা', price: 60, rent: [2, 10, 30, 90, 160, 250], houseCost: 50 },

  { id: 4, type: 'tax', name: 'Income Tax', bn: 'আয়কর', amount: 200 },
  { id: 5, type: 'rail', group: GROUPS.RAIL, name: 'Dhaka Station', bn: 'ঢাকা স্টেশন', price: 200, rent: [25, 50, 100, 200] },
  { id: 6, type: 'property', group: GROUPS.LIGHT_BLUE, name: 'Lalbazar', bn: 'লালবাজার', price: 100, rent: [4, 20, 60, 180, 320, 450], houseCost: 50 },
  { id: 7, type: 'chance', name: 'Sujog', bn: 'সুযোগ' },
  { id: 8, type: 'property', group: GROUPS.LIGHT_BLUE, name: 'Islampur', bn: 'ইসলামপুর', price: 100, rent: [4, 20, 60, 180, 320, 450], houseCost: 50 },
  { id: 9, type: 'property', group: GROUPS.LIGHT_BLUE, name: 'Beirpura', bn: 'বেইরপুর', price: 120, rent: [6, 30, 90, 270, 400, 550], houseCost: 50 },

  { id: 10, type: 'jail', name: 'Jail', bn: 'জেল' },
  { id: 11, type: 'property', group: GROUPS.PINK, name: 'Nizamabad', bn: 'নিজামাবাদ', price: 140, rent: [6, 30, 90, 270, 400, 550], houseCost: 50 },
  { id: 12, type: 'utility', group: GROUPS.UTILITY, name: 'Bijoy', bn: 'বিদ্যুৎ', price: 150, baseRent: 4, diceRent: 10 },
  { id: 13, type: 'property', group: GROUPS.PINK, name: 'Green Road', bn: 'গ্রীন রোড', price: 140, rent: [6, 30, 90, 270, 400, 550], houseCost: 50 },
  { id: 14, type: 'property', group: GROUPS.PINK, name: 'Banglabazar', bn: 'বাংলাবাজার', price: 160, rent: [8, 40, 100, 300, 450, 600], houseCost: 50 },

  { id: 15, type: 'rail', group: GROUPS.RAIL, name: 'Narayanganj', bn: 'নারায়ণগঞ্জ', price: 200, rent: [25, 50, 100, 200] },
  { id: 16, type: 'property', group: GROUPS.ORANGE, name: 'Dhanmondi', bn: 'ধানমন্ডি', price: 180, rent: [8, 40, 100, 300, 450, 600], houseCost: 50 },
  { id: 17, type: 'chest', name: 'Bhagya', bn: 'ভাগ্য' },
  { id: 18, type: 'property', group: GROUPS.ORANGE, name: 'Banani', bn: 'বনানী', price: 200, rent: [10, 50, 150, 450, 625, 750], houseCost: 50 },
  { id: 19, type: 'property', group: GROUPS.ORANGE, name: 'Gulshan', bn: 'গুলশান', price: 220, rent: [12, 60, 180, 500, 700, 900], houseCost: 50 },

  { id: 20, type: 'parking', name: 'Free Parking', bn: 'ফ্রি পার্কিং' },
  { id: 21, type: 'property', group: GROUPS.RED, name: 'Uttara Model Town', bn: 'উত্তরা মডেল টাউন', price: 220, rent: [10, 50, 150, 450, 625, 750], houseCost: 50 },
  { id: 22, type: 'chance', name: 'Sujog', bn: 'সুযোগ' },
  { id: 23, type: 'property', group: GROUPS.RED, name: 'Jatrabari', bn: 'যতীপুর', price: 220, rent: [11, 55, 150, 450, 625, 750], houseCost: 50 },
  { id: 24, type: 'property', group: GROUPS.RED, name: 'Dhiranagar', bn: 'ধীরনগর', price: 240, rent: [14, 70, 200, 550, 750, 900], houseCost: 50 },

  { id: 25, type: 'rail', group: GROUPS.RAIL, name: 'Chattogram', bn: 'চট্টগ্রাম', price: 200, rent: [25, 50, 100, 200] },
  { id: 26, type: 'property', group: GROUPS.YELLOW, name: 'Mirpur', bn: 'মিরপুর', price: 260, rent: [12, 60, 180, 500, 700, 900], houseCost: 100 },
  { id: 27, type: 'property', group: GROUPS.YELLOW, name: 'Farmgate', bn: 'ফার্মগেট', price: 260, rent: [14, 70, 200, 550, 750, 900], houseCost: 100 },
  { id: 28, type: 'utility', group: GROUPS.UTILITY, name: 'Paani', bn: 'পানি', price: 150, baseRent: 4, diceRent: 10 },
  { id: 29, type: 'property', group: GROUPS.YELLOW, name: 'Kalimpur', bn: 'কালীপুর', price: 280, rent: [16, 80, 220, 600, 800, 1000], houseCost: 100 },

  { id: 30, type: 'gotojail', name: 'Go To Jail', bn: 'জেলে যান' },
  { id: 31, type: 'property', group: GROUPS.GREEN, name: 'Sonargaon', bn: 'সোনারগাছী', price: 300, rent: [14, 70, 200, 550, 750, 900], houseCost: 100 },
  { id: 32, type: 'property', group: GROUPS.GREEN, name: 'Jatiyo Sangsad', bn: 'জাতীয় সংসদ', price: 300, rent: [16, 80, 220, 600, 800, 1000], houseCost: 100 },
  { id: 33, type: 'chest', name: 'Bhagya', bn: 'ভাগ্য' },
  { id: 34, type: 'property', group: GROUPS.GREEN, name: 'Dhan Bari', bn: 'ধানবাড়ি', price: 320, rent: [18, 90, 250, 700, 875, 1050], houseCost: 100 },

  { id: 35, type: 'rail', group: GROUPS.RAIL, name: 'Sylhet', bn: 'সিলেট', price: 200, rent: [25, 50, 100, 200] },
  { id: 36, type: 'chance', name: 'Sujog', bn: 'সুযোগ' },
  { id: 37, type: 'property', group: GROUPS.DARK_BLUE, name: 'Old Dhaka', bn: 'পুরান ঢাকা', price: 350, rent: [20, 100, 300, 750, 925, 1100], houseCost: 100 },
  { id: 38, type: 'luxury', name: 'Luxury Tax', bn: 'বিলাসিতা কর', amount: 100 },
  { id: 39, type: 'property', group: GROUPS.DARK_BLUE, name: 'Baitul Mukarram', bn: 'বায়তুল মোকাররম', price: 400, rent: [22, 110, 330, 800, 975, 1150], houseCost: 100 }
];

const START_CASH = 1500;
const GO_SALARY = 200;
const JAIL_INDEX = 10;
const JAIL_FINE = 50;
const MAX_JAIL_TURNS = 3;
const MAX_HOUSES = 5;

const CHEST_CARDS = [
  { id: 'c1', text: 'Go to START. Collect Tk {salary}.', bn: 'শুরুতে ফিরে যান। Tk {salary} পান।', action: 'goto', to: 0, salary: true },
  { id: 'c2', text: 'Bank error in your favour. Collect Tk 200.', bn: 'ব্যাংকের ভুল, আপনি পান Tk 200।', action: 'credit', amount: 200 },
  { id: 'c3', text: "Doctor's fees. Pay Tk 50.", bn: 'ডাক্তারের ফি। Tk 50 দিন।', action: 'debit', amount: 50 },
  { id: 'c4', text: 'From sale of stock you get Tk 50.', bn: 'শেয়ার বিক্রি থেকে Tk 50।', action: 'credit', amount: 50 },
  { id: 'c5', text: 'Get out of jail free. Keep this card.', bn: 'জেল থেকে ফ্রি ছাড়া পান। কার্ডটি রাখুন।', action: 'getout' },
  { id: 'c6', text: 'Go directly to jail.', bn: 'সরাসরি জেলে যান।', action: 'goto', to: JAIL_INDEX, jail: true },
  { id: 'c7', text: 'Holiday fund matures. Receive Tk 100.', bn: 'ছুটির তহবিল পরিপক্ব। Tk 100 পান।', action: 'credit', amount: 100 },
  { id: 'c8', text: 'Income tax refund. Collect Tk 20.', bn: 'আয়কর ফেরত। Tk 20 পান।', action: 'credit', amount: 20 },
  { id: 'c9', text: 'Life insurance matures. Collect Tk 100.', bn: 'জীবন বীমা পরিপক্ব। Tk 100 পান।', action: 'credit', amount: 100 },
  { id: 'c10', text: 'Pay hospital fees of Tk 100.', bn: 'হাসপাতালের ফি Tk 100 দিন।', action: 'debit', amount: 100 },
  { id: 'c11', text: 'Pay school fees of Tk 50.', bn: 'স্কুলের ফি Tk 50 দিন।', action: 'debit', amount: 50 },
  { id: 'c12', text: 'Consultancy fee. Receive Tk 25.', bn: 'পরামর্শ ফি। Tk 25 পান।', action: 'credit', amount: 25 },
  { id: 'c13', text: 'Street painting fine. Pay Tk 15.', bn: 'রাস্তা আঁকার জরিমানা Tk 15।', action: 'debit', amount: 15 },
  { id: 'c14', text: 'Beauty contest prize. Receive Tk 50.', bn: 'সৌন্দর্য প্রতিযোগিতার পুরস্কার Tk 50।', action: 'credit', amount: 50 },
  { id: 'c15', text: 'You inherit Tk 100.', bn: 'আপনি Tk 100 উত্তরাধিকার পান।', action: 'credit', amount: 100 },
  { id: 'c16', text: 'Refund of Tk 25.', bn: 'Tk 25 ফেরত পান।', action: 'credit', amount: 25 }
];

const CHANCE_CARDS = [
  { id: 'n1', text: 'Go to START. Collect Tk {salary}.', bn: 'শুরুতে ফিরে যান। Tk {salary} পান।', action: 'goto', to: 0, salary: true },
  { id: 'n2', text: 'Advance to Kali Bazar.', bn: 'কালীবাজারে যান।', action: 'goto', to: 1 },
  { id: 'n3', text: 'Advance to Lalbazar.', bn: 'লালবাজারে যান।', action: 'goto', to: 6 },
  { id: 'n4', text: 'Advance to Dhaka Station. Pay owner twice the rent.', bn: 'ঢাকা স্টেশনে যান। মালিককে দ্বিগুণ ভাড়া দিন।', action: 'goto', to: 5, doubleRent: true },
  { id: 'n5', text: 'Advance to the nearest station. Pay owner twice the rent.', bn: 'নিকটতম স্টেশনে যান। মালিককে দ্বিগুণ ভাড়া দিন।', action: 'nearestRail', doubleRent: true },
  { id: 'n6', text: 'Advance to the nearest utility. Pay 10x the dice roll.', bn: 'নিকটতম সেবা কেন্দ্রে যান। ১০ গুণ ডাইস দিন।', action: 'nearestUtility', diceRent: true },
  { id: 'n7', text: 'Bank pays you dividend of Tk 50.', bn: 'ব্যাংক লভাংশ দেয় Tk 50।', action: 'credit', amount: 50 },
  { id: 'n8', text: 'Get out of jail free. Keep this card.', bn: 'জেল থেকে ফ্রি ছাড়া পান। কার্ডটি রাখুন।', action: 'getout' },
  { id: 'n9', text: 'Go directly to jail.', bn: 'সরাসরি জেলে যান।', action: 'goto', to: JAIL_INDEX, jail: true },
  { id: 'n10', text: 'Go back three spaces.', bn: 'তিন ঘর পিছনে যান।', action: 'back', amount: 3 },
  { id: 'n11', text: 'Poor tax. Pay Tk 15.', bn: 'গরিব খাজা। Tk 15 দিন।', action: 'debit', amount: 15 },
  { id: 'n12', text: 'Hospital fees. Pay Tk 100.', bn: 'হাসপাতালের ফি। Tk 100 দিন।', action: 'debit', amount: 100 },
  { id: 'n13', text: 'School fees. Pay Tk 50.', bn: 'স্কুলের ফি। Tk 50 দিন।', action: 'debit', amount: 50 },
  { id: 'n14', text: 'Repairs. Pay Tk 100 per house and Tk 200 per hotel.', bn: 'মেরামত। প্রতি বাড়ি Tk 100, প্রতি হোটেল Tk 200।', action: 'repairs', house: 100, hotel: 200 },
  { id: 'n15', text: 'Fine. Pay Tk 100.', bn: 'জরিমানা Tk 100 দিন।', action: 'debit', amount: 100 },
  { id: 'n16', text: 'Advance to jail.', bn: 'জেলে যান।', action: 'goto', to: JAIL_INDEX, jail: true }
];

function getTile(id) {
  return TILES[((id % 40) + 40) % 40];
}

function isOwnable(tile) {
  return tile.type === 'property' || tile.type === 'rail' || tile.type === 'utility';
}

function groupMembers(group) {
  return TILES.filter((t) => t.group === group);
}

function groupOf(tileId) {
  return getTile(tileId).group;
}

function mortgageValue(tile) {
  return Math.floor(tile.price / 2);
}

function unmortgageValue(tile) {
  // Multiply as a fraction to avoid float drift (50 * 1.1 === 55.000000000000007).
  return Math.ceil((mortgageValue(tile) * 11) / 10);
}

function houseCostOf(tile) {
  return tile.houseCost || 0;
}

module.exports = {
  GROUPS,
  TILES,
  CHEST_CARDS,
  CHANCE_CARDS,
  START_CASH,
  GO_SALARY,
  JAIL_INDEX,
  JAIL_FINE,
  MAX_JAIL_TURNS,
  MAX_HOUSES,
  getTile,
  isOwnable,
  groupMembers,
  groupOf,
  mortgageValue,
  unmortgageValue,
  houseCostOf
};