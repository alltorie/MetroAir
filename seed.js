require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas for seeding...'))
  .catch(err => {
    console.error('Connection failed:', err);
    process.exit(1);
  });

const citySchema = new mongoose.Schema({
  name: String,
  lat: Number,
  lng: Number
});

const City = mongoose.model('City', citySchema);

const metroManilaCities = [
  { name: 'City of Manila', lat: 14.5995, lng: 120.9842 },
  { name: 'Quezon City', lat: 14.6760, lng: 121.0437 },
  { name: 'Makati', lat: 14.5547, lng: 121.0244 },
  { name: 'Taguig', lat: 14.5176, lng: 121.0509 },
  { name: 'Pasig', lat: 14.5764, lng: 121.0851 },
  { name: 'Mandaluyong', lat: 14.5794, lng: 121.0359 },
  { name: 'San Juan', lat: 14.6019, lng: 121.0355 },
  { name: 'Marikina', lat: 14.6507, lng: 121.1029 },
  { name: 'Pasay', lat: 14.5378, lng: 121.0014 },
  { name: 'Parañaque', lat: 14.4793, lng: 121.0198 },
  { name: 'Las Piñas', lat: 14.4445, lng: 120.9939 },
  { name: 'Muntinlupa', lat: 14.4081, lng: 121.0415 },
  { name: 'Caloocan', lat: 14.6500, lng: 120.9830 },
  { name: 'Malabon', lat: 14.6625, lng: 120.9569 },
  { name: 'Navotas', lat: 14.6667, lng: 120.9500 },
  { name: 'Valenzuela', lat: 14.7011, lng: 120.9830 },
  { name: 'Pateros', lat: 14.5454, lng: 121.0686 }
];

async function seedDatabase() {
  try {
    await City.deleteMany({}); // Clears any old entries to prevent duplicates
    await City.insertMany(metroManilaCities);
    console.log('Successfully inserted Metro Manila cities into MongoDB Atlas!');
  } catch (error) {
    console.error('Error inserting data:', error);
  } finally {
    mongoose.connection.close();
  }
}

seedDatabase();